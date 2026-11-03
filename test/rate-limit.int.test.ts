import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type TestApp } from './harness.js'

describe('rate limit on POST /api/v1/notes', () => {
    let t: TestApp

    beforeAll(async () => {
        t = await startApp({
            RATE_LIMIT_PER_MINUTE: '30',
        })
    })
    afterAll(async () => {
        await t?.close()
    })

    it('allows 30 creates per minute per IP, then answers 429', async () => {
        for (let i = 0; i < 30; i++) {
            const res = await t
                .http()
                .post('/api/v1/notes')
                .send({
                    title: `n${i}`,
                })
            expect(res.status).toBe(201)
        }
        const limited = await t.http().post('/api/v1/notes').send({
            title: 'x',
        })
        expect(limited.status).toBe(429)
        expect(limited.headers['retry-after']).toEqual(expect.any(String))
        expect(limited.body).toEqual({
            code: 'RATE_LIMITED',
            message: 'Too many requests',
            requestId: limited.headers['x-request-id'],
        })

        // Reads are not limited.
        const list = await t.http().get('/api/v1/notes')
        expect(list.status).toBe(200)
    })
})
