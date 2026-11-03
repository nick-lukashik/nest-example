import { randomUUID, randomUUIDv7 } from 'node:crypto'
import { type ChannelModel, connect } from 'amqplib'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest'
import { activityQueue } from '../src/activity/activity.consumer.js'
import type { Envelope } from '../src/common/messaging/event.js'
import { enqueueEvent } from '../src/common/messaging/outbox.js'
import { OutboxRelay } from '../src/common/messaging/outbox-relay.js'
import { RabbitMq } from '../src/common/messaging/rabbitmq.js'
import { QueueMissingError, replayDeadLetters } from '../src/common/messaging/replay.js'
import {
    deadLetterQueueName,
    defineQueue,
    eventsExchange,
    queueDeclarations,
    retryQueueName,
} from '../src/common/messaging/topology.js'
import { inbox, outbox } from '../src/db/schema.js'
import { noteCreatedV1 } from '../src/notes/notes.events.js'
import { startApp, type TestApp } from './harness.js'

const ACTIVITY = activityQueue.name

describe('messaging guarantees', () => {
    let t: TestApp
    let rabbit: RabbitMq
    let admin: ChannelModel

    beforeAll(async () => {
        t = await startApp()
        rabbit = t.app.get(RabbitMq)
        admin = await connect(inject('rabbitmqUrl'))
    })
    afterAll(async () => {
        await admin?.close()
        await t?.close()
    })

    /** A fresh channel per operation: a failed one (404) closes its channel. */
    const channel = async () => {
        const ch = await admin.createConfirmChannel()
        ch.on('error', () => undefined)
        return ch
    }
    /** Ready messages in a queue, or -1 while it does not exist. */
    const count = async (queue: string) => {
        const ch = await channel()
        try {
            return (await ch.checkQueue(queue)).messageCount
        } catch {
            return -1
        } finally {
            await ch.close().catch(() => undefined)
        }
    }
    const sendTo = async (queue: string, envelope: Envelope) => {
        const ch = await channel()
        ch.sendToQueue(queue, Buffer.from(JSON.stringify(envelope)), {
            persistent: true,
            messageId: envelope.eventId,
        })
        await ch.waitForConfirms()
        await ch.close()
    }
    const outboxRow = async (eventId: string) => {
        const [row] = await t.db.select().from(outbox).where(eq(outbox.eventId, eventId))
        return row
    }
    const processed = async (eventId: string) =>
        (await t.db.select().from(inbox).where(eq(inbox.eventId, eventId))).length
    const testEvent = (producer: string): Envelope => ({
        eventId: randomUUIDv7(),
        type: 'test.thing.happened.v1',
        producer,
        occurredAt: new Date().toISOString(),
        aggregateId: 'a1',
        payload: {},
    })
    const noteEvent = () =>
        noteCreatedV1.create({
            aggregateId: randomUUIDv7(),
            payload: {
                noteId: randomUUIDv7(),
                title: 'replayed',
                createdAt: new Date().toISOString(),
            },
        })

    it('keeps an unroutable event in the outbox, counts it, and publishes it once a queue is bound', async () => {
        const producer = `test-${randomUUID().slice(0, 8)}`
        const ch = await channel()
        await ch.assertExchange(eventsExchange(producer), 'topic', {
            durable: true,
        })
        const before = await t.metric('outbox_publish_failures_total', {
            reason: 'unroutable',
        })
        const event = testEvent(producer)
        await enqueueEvent(t.db, event)
        t.app.get(OutboxRelay).kick()

        // The exchange exists but no queue is bound: the broker confirms and returns it.
        await expect
            .poll(async () => (await outboxRow(event.eventId))?.lastError ?? '', {
                timeout: 10_000,
            })
            .toContain('Unroutable')
        expect(await outboxRow(event.eventId)).toMatchObject({
            status: 'pending',
            publishedAt: null,
        })
        expect(
            await t.metric('outbox_publish_failures_total', {
                reason: 'unroutable',
            }),
        ).toBeGreaterThan(before)

        const sink = await ch.assertQueue('', {
            exclusive: true,
        })
        await ch.bindQueue(sink.queue, eventsExchange(producer), event.type)
        await expect
            .poll(async () => (await outboxRow(event.eventId))?.status, {
                timeout: 15_000,
            })
            .toBe('published')
        const delivered = await ch.get(sink.queue, {
            noAck: true,
        })
        expect(delivered === false ? undefined : delivered.properties.messageId).toBe(event.eventId)
    })

    it('opens a new publisher channel after a publish closed it', async () => {
        const event = noteEvent()
        // A missing exchange is a channel error (404), not a return: the publisher channel closes.
        await expect(rabbit.publish(`missing-${randomUUID()}.events`, event)).rejects.toThrow(/NOT_FOUND|closed/i)
        await rabbit.publish(eventsExchange(event.producer), event)
        await expect
            .poll(() => processed(event.eventId), {
                timeout: 10_000,
            })
            .toBe(1)
    })

    it('does not lose a failed message whose retry queue is missing', async () => {
        const producer = `test-${randomUUID().slice(0, 8)}`
        const spec = defineQueue(
            `${producer}.work`,
            [
                {
                    producer,
                    types: [
                        'test.thing.happened.v1',
                    ],
                },
            ],
            {
                retryDelaysMs: [
                    60_000,
                ],
            },
        )
        const attempts: number[] = []
        await rabbit.subscribe(spec, async (_event, { attempt }) => {
            attempts.push(attempt)
            throw new Error('transient failure')
        })
        expect(rabbit.consumerStates()[spec.name]).toBe('up')
        const retry = retryQueueName(spec.name, 0)
        await (await channel()).deleteQueue(retry)
        const moveFailures = await t.metric('messaging_move_failures_total', {
            queue: spec.name,
        })

        await rabbit.publish(eventsExchange(producer), testEvent(producer))

        // The move is returned, the original stays unacked, the consumer restarts and
        // declares the retry queue again; the redelivered message then lands there.
        await expect
            .poll(() => count(retry), {
                timeout: 15_000,
            })
            .toBe(1)
        expect(await count(spec.name)).toBe(0)
        expect(attempts.length).toBeGreaterThanOrEqual(2)
        expect(
            await t.metric('messaging_move_failures_total', {
                queue: spec.name,
            }),
        ).toBeGreaterThan(moveFailures)
        expect(rabbit.consumerStates()[spec.name]).toBe('up')
    })

    it('re-subscribes a consumer whose queue was deleted, and consumes again', async () => {
        const restarts = await t.metric('messaging_consumer_restarts_total', {
            queue: ACTIVITY,
            reason: 'cancelled',
        })
        await (await channel()).deleteQueue(ACTIVITY)

        await expect
            .poll(
                () =>
                    t.metric('messaging_consumer_restarts_total', {
                        queue: ACTIVITY,
                        reason: 'cancelled',
                    }),
                {
                    timeout: 10_000,
                },
            )
            .toBeGreaterThan(restarts)
        await expect.poll(() => rabbit.consumerStates()[ACTIVITY]).toBe('up')
        expect(await count(ACTIVITY)).toBeGreaterThanOrEqual(0)

        const created = await t.http().post('/api/v1/notes').send({
            title: 'after cancel',
        })
        expect(created.status).toBe(201)
        const [event] = await t.db
            .select()
            .from(outbox)
            .where(sql`${outbox.envelope}->'payload'->>'noteId' = ${created.body.id}`)
        if (!event) throw new Error('no outbox event')
        await expect
            .poll(() => processed(event.eventId), {
                timeout: 10_000,
            })
            .toBe(1)
    })

    it('recreates a consumer channel closed by a channel error', async () => {
        const broken = rabbit.consumerChannel(ACTIVITY)
        if (!broken) throw new Error('no consumer channel')
        const restarts = await t.metric('messaging_consumer_restarts_total', {
            queue: ACTIVITY,
            reason: 'channel_closed',
        })
        // A 404 on the consumer's own channel: the broker closes that channel only.
        await broken.checkQueue(`missing-${randomUUID()}`).catch(() => undefined)

        await expect
            .poll(() => rabbit.consumerChannel(ACTIVITY) !== broken && rabbit.consumerStates()[ACTIVITY] === 'up', {
                timeout: 10_000,
            })
            .toBe(true)
        expect(
            await t.metric('messaging_consumer_restarts_total', {
                queue: ACTIVITY,
                reason: 'channel_closed',
            }),
        ).toBeGreaterThan(restarts)
        expect(rabbit.connected).toBe(true)

        const event = noteEvent()
        await rabbit.publish(eventsExchange(event.producer), event)
        await expect
            .poll(() => processed(event.eventId), {
                timeout: 10_000,
            })
            .toBe(1)
    })

    it('reports each consumer in readiness and metrics', async () => {
        const res = await t.http().get('/health/ready')
        expect(res.status).toBe(200)
        expect(res.body.info.rabbitmq).toMatchObject({
            status: 'up',
            consumers: {
                [ACTIVITY]: 'up',
            },
        })
        expect(
            await t.metric('messaging_consumer_up', {
                queue: ACTIVITY,
            }),
        ).toBe(1)
        expect(await t.metric('messaging_broker_up')).toBe(1)
    })

    it('replays dead letters back to their queue, at most --limit of them', async () => {
        const dlq = deadLetterQueueName(ACTIVITY)
        const first = noteEvent()
        const second = noteEvent()
        await sendTo(dlq, first)
        await sendTo(dlq, second)
        const url = inject('rabbitmqUrl')

        await expect(
            replayDeadLetters(url, ACTIVITY, {
                limit: 1,
            }),
        ).resolves.toEqual({
            queue: ACTIVITY,
            replayed: 1,
            remaining: 1,
        })
        await expect(replayDeadLetters(url, ACTIVITY)).resolves.toMatchObject({
            replayed: 1,
            remaining: 0,
        })
        await expect
            .poll(async () => (await processed(first.eventId)) + (await processed(second.eventId)), {
                timeout: 10_000,
            })
            .toBe(2)
    })

    it('refuses to replay into a missing queue and keeps the dead letters', async () => {
        const name = `test-${randomUUID().slice(0, 8)}.gone`
        const ch = await channel()
        const [dlq] = queueDeclarations(defineQueue(name, []))
        if (!dlq) throw new Error('no dlq declaration')
        await ch.assertQueue(dlq.name, {
            durable: true,
            arguments: dlq.arguments,
        })
        await sendTo(dlq.name, noteEvent())

        await expect(replayDeadLetters(inject('rabbitmqUrl'), name)).rejects.toThrow(QueueMissingError)
        expect(await count(dlq.name)).toBe(1)
        await (await channel()).deleteQueue(dlq.name)
    })
})
