import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HealthRegistry } from '../src/common/health/health.registry.js'
import { Metrics } from '../src/common/metrics/metrics.js'
import { startApp, type TestApp } from './harness.js'

describe('health, OpenAPI, metrics', () => {
    let t: TestApp

    beforeAll(async () => {
        t = await startApp()
    })
    afterAll(async () => {
        await t?.close()
    })

    it('live answers without checking dependencies', async () => {
        const res = await t.http().get('/health/live')
        expect(res.status).toBe(200)
        expect(res.headers['x-app-version']).toBe('test')
    })

    it('ready reports Postgres, Redis and RabbitMQ', async () => {
        const res = await t.http().get('/health/ready')
        expect(res.status).toBe(200)
        expect(res.body.status).toBe('ok')
        expect(Object.keys(res.body.info).sort()).toEqual([
            'postgres',
            'rabbitmq',
            'redis',
        ])
    })

    it('ready answers 503 while a dependency is down', async () => {
        t.app.get(HealthRegistry).register('broken', async () => {
            throw new Error('connection refused')
        })
        const res = await t.http().get('/health/ready')
        expect(res.status).toBe(503)
        expect(res.body.status).toBe('error')
        expect(res.body.error.broken).toMatchObject({
            status: 'down',
        })
    })

    it('serves the OpenAPI document generated from the Zod schemas', async () => {
        const res = await t.http().get('/openapi.json')
        expect(res.status).toBe(200)
        expect(Object.keys(res.body.paths)).toEqual(
            expect.arrayContaining([
                '/api/v1/notes',
                '/api/v1/notes/{id}',
                '/api/v1/notes/stats',
            ]),
        )
        expect(res.body.components.schemas.Note.required).toEqual([
            'id',
            'title',
            'body',
            'createdAt',
        ])
        expect(res.body.paths['/api/v1/notes'].post.requestBody.content['application/json'].schema).toEqual({
            $ref: '#/components/schemas/CreateNote',
        })
    })

    it('counts requests by route template', async () => {
        await t.http().get('/api/v1/notes/01a19d24-0000-7000-8000-000000000000')
        const scrape = await t.app.get(Metrics).scrape()
        expect(scrape).toMatch(
            /http_server_requests_total\{method="GET",route="\/api\/v1\/notes\/:id",status_class="4xx"/,
        )
    })

    it('answers unknown routes with the contract body', async () => {
        const res = await t.http().get('/api/v1/unknown')
        expect(res.status).toBe(404)
        expect(res.body.code).toBe('NOT_FOUND')
    })
})
