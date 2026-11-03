import { createClient } from '@redis/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startContainer, startOwnRedis, stopContainer } from './containers.js'
import { startApp, type TestApp } from './harness.js'

const elapsedSince = (started: number) => performance.now() - started

/** Redis is paused, stopped and started in this file, so it has its own instance. */
describe('Redis outage', () => {
    let redis: Awaited<ReturnType<typeof startOwnRedis>>
    let t: TestApp

    beforeAll(async () => {
        redis = await startOwnRedis()
        t = await startApp({
            REDIS_URL: redis.url,
        })
    })
    afterAll(async () => {
        await t?.close()
        await redis?.container.stop()
    })

    const list = () => t.http().get('/api/v1/notes?limit=5')
    const create = (title: string) =>
        t.http().post('/api/v1/notes').send({
            title,
        })

    it('serves reads and writes within budget while Redis hangs', async () => {
        expect((await create('before pause')).status).toBe(201)
        const pauser = createClient({
            url: redis.url,
        })
        await pauser.connect()
        // Every client's commands now wait for 3 s without an answer.
        await pauser.sendCommand([
            'CLIENT',
            'PAUSE',
            '3000',
            'ALL',
        ])
        pauser.destroy()
        const readErrors = await t.metric('cache_errors_total', {
            operation: 'read',
        })
        const failOpen = await t.metric('rate_limit_fail_open_total')

        let started = performance.now()
        const read = await list()
        expect(read.status).toBe(200)
        expect(read.headers['x-cache']).toBe('MISS')
        expect(read.body.items[0].title).toBe('before pause')
        expect(elapsedSince(started)).toBeLessThan(1_500)

        started = performance.now()
        expect((await create('during pause')).status).toBe(201)
        // Rate limit (500 ms) and cache invalidation (500 ms), each given up.
        expect(elapsedSince(started)).toBeLessThan(2_500)
        expect(
            await t.metric('cache_errors_total', {
                operation: 'read',
            }),
        ).toBeGreaterThan(readErrors)
        expect(await t.metric('rate_limit_fail_open_total')).toBeGreaterThan(failOpen)

        // Answers resume after the pause; replies of abandoned commands are discarded in order.
        await expect
            .poll(async () => (await list()).headers['x-cache'], {
                timeout: 10_000,
                interval: 500,
            })
            .toBe('HIT')
        expect((await list()).body.items[0].title).toBe('during pause')
    })

    it('bypasses the cache and lets requests through while Redis is down, then recovers', async () => {
        expect((await list()).status).toBe(200)
        await stopContainer(redis.container)
        await expect
            .poll(() => t.redis.isReady, {
                timeout: 15_000,
            })
            .toBe(false)
        const failOpen = await t.metric('rate_limit_fail_open_total')

        const read = await list()
        expect(read.status).toBe(200)
        expect(read.headers['x-cache']).toBe('MISS')
        const created = await create('while redis is down')
        expect(created.status).toBe(201)
        expect(await t.metric('rate_limit_fail_open_total')).toBeGreaterThan(failOpen)
        expect(await t.metric('redis_up')).toBe(0)

        const ready = await t.http().get('/health/ready')
        expect(ready.status).toBe(200)
        expect(ready.body.status).toBe('degraded')
        expect(ready.body.info.redis.status).toBe('degraded')
        expect(ready.body.info.postgres.status).toBe('up')

        await startContainer(redis.container)
        await expect
            .poll(() => t.redis.isReady, {
                timeout: 30_000,
            })
            .toBe(true)
        expect((await list()).headers['x-cache']).toBe('MISS')
        const cached = await list()
        expect(cached.headers['x-cache']).toBe('HIT')
        expect(cached.body.items[0].title).toBe('while redis is down')
        expect((await t.http().get('/health/ready')).body.status).toBe('ok')
        expect(await t.metric('redis_up')).toBe(1)
    }, 60_000)
})
