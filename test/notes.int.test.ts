import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ActivityConsumer, activityQueue } from '../src/activity/activity.consumer.js'
import { RabbitMq } from '../src/common/messaging/rabbitmq.js'
import { eventsExchange } from '../src/common/messaging/topology.js'
import { activity, inbox, outbox } from '../src/db/schema.js'
import { NOTES_PRODUCER } from '../src/notes/notes.events.js'
import { startApp, type TestApp } from './harness.js'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('notes', () => {
    let t: TestApp

    beforeAll(async () => {
        t = await startApp()
    })
    afterAll(async () => {
        await t?.close()
    })

    const create = (title: string, body = '') =>
        t.http().post('/api/v1/notes').send({
            title,
            body,
        })

    it('creates a note and echoes the request id', async () => {
        const res = await create('  First  ', 'hello').set('x-request-id', 'test-request-0001')
        expect(res.status).toBe(201)
        expect(res.headers['x-request-id']).toBe('test-request-0001')
        expect(res.body).toEqual({
            id: expect.stringMatching(UUID_V7),
            title: 'First',
            body: 'hello',
            createdAt: expect.any(String),
        })
        expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt)
    })

    it('returns a note by id, 404 for unknown and malformed ids', async () => {
        const { body: note } = await create('By id')
        const found = await t.http().get(`/api/v1/notes/${note.id}`)
        expect(found.status).toBe(200)
        expect(found.body).toEqual(note)

        for (const id of [
            '01a19d24-0000-7000-8000-000000000000',
            'not-a-uuid',
        ]) {
            const missing = await t.http().get(`/api/v1/notes/${id}`)
            expect(missing.status).toBe(404)
            expect(missing.body).toEqual({
                code: 'NOT_FOUND',
                message: 'Note not found',
                requestId: missing.headers['x-request-id'],
            })
        }
    })

    it('lists newest first; the second read comes from Redis until a create', async () => {
        const first = await t.http().get('/api/v1/notes?limit=50')
        expect(first.status).toBe(200)
        expect(first.headers['x-cache']).toBe('MISS')
        const titles = first.body.items.map((n: { title: string }) => n.title)
        expect(titles.slice(0, 2)).toEqual([
            'By id',
            'First',
        ])

        const second = await t.http().get('/api/v1/notes?limit=50')
        expect(second.headers['x-cache']).toBe('HIT')
        expect(second.body).toEqual(first.body)

        await create('Newest')
        const third = await t.http().get('/api/v1/notes?limit=50')
        expect(third.headers['x-cache']).toBe('MISS')
        expect(third.body.items[0].title).toBe('Newest')
    })

    it('pages with an opaque cursor', async () => {
        const page1 = await t.http().get('/api/v1/notes?limit=2')
        expect(page1.body.items).toHaveLength(2)
        expect(page1.body.nextCursor).toEqual(expect.any(String))

        const page2 = await t.http().get('/api/v1/notes').query({
            limit: 2,
            cursor: page1.body.nextCursor,
        })
        expect(page2.status).toBe(200)
        expect(page2.body.items).toHaveLength(1)
        expect(page2.body.nextCursor).toBeNull()
        const ids = [
            ...page1.body.items,
            ...page2.body.items,
        ].map((n: { id: string }) => n.id)
        expect(new Set(ids).size).toBe(3)
    })

    it('rejects invalid input with every failing field', async () => {
        const res = await t
            .http()
            .post('/api/v1/notes')
            .send({
                title: '',
                body: 'x'.repeat(5001),
            })
        expect(res.status).toBe(400)
        expect(res.body).toMatchObject({
            code: 'VALIDATION_FAILED',
            requestId: expect.any(String),
        })
        expect(res.body.details.map((d: { path: string }) => d.path)).toEqual([
            'title',
            'body',
        ])

        const query = await t.http().get('/api/v1/notes?limit=0')
        expect(query.status).toBe(400)
        expect(query.body.details[0].path).toBe('limit')

        const cursor = await t.http().get('/api/v1/notes?cursor=forged')
        expect(cursor.status).toBe(400)
        expect(cursor.body.details).toEqual([
            {
                path: 'cursor',
                message: 'Invalid cursor',
            },
        ])

        const json = await t.http().post('/api/v1/notes').set('content-type', 'application/json').send('{oops')
        expect(json.status).toBe(400)
        expect(json.body.code).toBe('VALIDATION_FAILED')
    })

    it('jobs: each create queues the pg-boss stats job in its transaction', async () => {
        await expect
            .poll(async () => (await t.http().get('/api/v1/notes/stats')).body, {
                timeout: 15_000,
                interval: 250,
            })
            .toEqual({
                total: 3,
                createdLastHour: 3,
            })
    })

    it('events: outbox → RabbitMQ → inbox → activity feed', async () => {
        await expect
            .poll(async () => (await t.db.select().from(activity)).length, {
                timeout: 15_000,
                interval: 250,
            })
            .toBe(3)
        const entries = await t.db.select().from(activity)
        expect(entries.map(e => e.summary).sort()).toEqual([
            'By id',
            'First',
            'Newest',
        ])

        const events = await t.db.select().from(outbox)
        expect(events).toHaveLength(3)
        expect(events.every(e => e.status === 'published')).toBe(true)
        expect(events[0]?.type).toBe('notes.note.created.v1')
        const processed = await t.db
            .select({
                count: sql<number>`count(*)::int`,
            })
            .from(inbox)
            .where(eq(inbox.consumer, activityQueue.name))
        expect(processed[0]?.count).toBe(3)
    })

    it('handles a redelivered event once (idempotent inbox)', async () => {
        const [event] = await t.db.select().from(outbox).limit(1)
        if (!event) throw new Error('no outbox event')
        const consumer = t.app.get(ActivityConsumer)
        const handle = vi.spyOn(consumer, 'handle')

        await t.app.get(RabbitMq).publish(eventsExchange(NOTES_PRODUCER), event.envelope as never)

        await expect
            .poll(() => handle.mock.settledResults[0], {
                timeout: 10_000,
            })
            .toEqual({
                type: 'fulfilled',
                value: 'duplicate',
            })
        const rows = await t.db.select().from(inbox).where(eq(inbox.eventId, event.eventId))
        expect(rows).toHaveLength(1)
        expect(await t.db.select().from(activity)).toHaveLength(3)
    })
})
