import { randomUUID } from 'node:crypto'
import { connect } from 'amqplib'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { activityQueue } from '../src/activity/activity.consumer.js'
import { RabbitMq } from '../src/common/messaging/rabbitmq.js'
import { defineQueue, queueDeclarations, retryQueueName } from '../src/common/messaging/topology.js'
import { inbox, outbox } from '../src/db/schema.js'
import { startContainer, startOwnRabbitMq, stopContainer, withLogs } from './containers.js'
import { startApp, type TestApp } from './harness.js'

const ACTIVITY = activityQueue.name

/** RabbitMQ is stopped and started in this file, so it has its own broker. */
describe('RabbitMQ outage', () => {
    let broker: Awaited<ReturnType<typeof startOwnRabbitMq>>
    let t: TestApp
    let rabbit: RabbitMq

    beforeAll(async () => {
        broker = await startOwnRabbitMq({
            // The broker retries unconfirmed at-least-once dead letters on this period (default minutes).
            RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS: '-rabbit dead_letter_worker_publisher_confirm_timeout 1000',
        })
        t = await startApp({
            RABBITMQ_URL: broker.url,
        })
        rabbit = t.app.get(RabbitMq)
    })
    afterAll(async () => {
        await t?.close()
        await broker?.container.stop()
    })

    it('accepts writes while the broker is down, stays ready, and drains the outbox after the restart', async () => {
        expect(rabbit.consumerStates()[ACTIVITY]).toBe('up')
        await stopContainer(broker.container)
        await expect
            .poll(() => rabbit.connected, {
                timeout: 20_000,
            })
            .toBe(false)

        const ids: string[] = []
        for (const title of [
            'during outage 1',
            'during outage 2',
        ]) {
            const res = await t.http().post('/api/v1/notes').send({
                title,
            })
            expect(res.status).toBe(201)
            ids.push(res.body.id)
        }
        const ready = await t.http().get('/health/ready')
        expect(ready.status).toBe(200)
        expect(ready.body.status).toBe('degraded')
        expect(ready.body.info.postgres.status).toBe('up')
        expect(ready.body.info.rabbitmq).toMatchObject({
            status: 'degraded',
            message: 'not connected',
            consumers: {
                [ACTIVITY]: 'down',
            },
        })
        expect(await t.metric('messaging_broker_up')).toBe(0)
        expect(
            await t.metric('messaging_consumer_up', {
                queue: ACTIVITY,
            }),
        ).toBe(0)
        expect(await t.metric('outbox_pending_events')).toBeGreaterThanOrEqual(2)
        // The stats job lives in Postgres (pg-boss), so it does not wait for the broker.
        await expect
            .poll(async () => (await t.http().get('/api/v1/notes/stats')).body.total, {
                timeout: 15_000,
                interval: 250,
            })
            .toBe(2)

        await startContainer(broker.container)

        // Reconnect (backoff up to 10 s), publish what waited, consume it.
        await withLogs(broker.container, () =>
            expect
                .poll(async () => (await t.db.select().from(outbox).where(eq(outbox.status, 'pending'))).length, {
                    timeout: 60_000,
                    interval: 500,
                })
                .toBe(0),
        )
        await expect.poll(() => rabbit.consumerStates()[ACTIVITY]).toBe('up')
        const events = await t.db.select().from(outbox)
        const noteOf = (envelope: unknown) =>
            (
                envelope as {
                    payload: {
                        noteId: string
                    }
                }
            ).payload.noteId
        const eventIds = events.filter(e => ids.includes(noteOf(e.envelope))).map(e => e.eventId)
        expect(eventIds).toHaveLength(2)
        await expect
            .poll(async () => (await t.db.select().from(inbox).where(inArray(inbox.eventId, eventIds))).length, {
                timeout: 20_000,
            })
            .toBe(2)
        const after = await t.http().get('/health/ready')
        expect(after.body.status).toBe('ok')
    }, 120_000)

    it('keeps a dead-lettered message while its target queue is missing (at-least-once)', async () => {
        const connection = await connect(broker.url)
        try {
            const ch = await connection.createConfirmChannel()
            const name = `test-${randomUUID().slice(0, 8)}.work`
            // The production arguments, with a short retry delay.
            const declarations = queueDeclarations(
                defineQueue(name, [], {
                    retryDelaysMs: [
                        300,
                    ],
                }),
            )
            const declare = async (queue: string) => {
                const declaration = declarations.find(d => d.name === queue)
                await ch.assertQueue(queue, {
                    durable: true,
                    arguments: declaration?.arguments,
                })
            }
            for (const { name: queue } of declarations) await declare(queue)
            const retry = retryQueueName(name, 0)
            await ch.deleteQueue(name)
            ch.sendToQueue(retry, Buffer.from('{}'), {
                persistent: true,
                messageId: 'kept',
            })
            await ch.waitForConfirms()

            // Expired, but the main queue does not exist: at-most-once would drop it here.
            await expect.poll(async () => (await ch.checkQueue(retry)).messageCount).toBe(0)
            await declare(name)
            await expect
                .poll(
                    async () => {
                        const message = await ch.get(name, {
                            noAck: true,
                        })
                        return message === false ? undefined : message.properties.messageId
                    },
                    {
                        timeout: 15_000,
                    },
                )
                .toBe('kept')
        } finally {
            await connection.close()
        }
    })
})
