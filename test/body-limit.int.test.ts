import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startApp, type TestApp } from './harness.js'

const MiB = 1024 * 1024

/** A JSON note whose serialized size is exactly `bytes`. */
const noteOfSize = (bytes: number) => {
    const empty = JSON.stringify({
        title: 't',
        body: '',
    })
    return JSON.stringify({
        title: 't',
        body: 'x'.repeat(bytes - empty.length),
    })
}

describe('request body limit (1 MiB)', () => {
    let t: TestApp

    beforeAll(async () => {
        t = await startApp()
    })
    afterAll(async () => {
        await t?.close()
    })

    const post = (contentType: string, body: string) =>
        t.http().post('/api/v1/notes').set('content-type', contentType).send(body)

    it('parses a JSON body of exactly 1 MiB (and then validates it)', async () => {
        const res = await post('application/json', noteOfSize(MiB))
        expect(res.status).toBe(400)
        expect(res.body.code).toBe('VALIDATION_FAILED')
    })

    it('answers 413 with the contract body above 1 MiB, for JSON and forms', async () => {
        for (const [contentType, body] of [
            [
                'application/json',
                noteOfSize(MiB + 1),
            ],
            [
                'application/x-www-form-urlencoded',
                `title=t&body=${'x'.repeat(MiB)}`,
            ],
        ] as const) {
            const res = await post(contentType, body)
            expect(res.status).toBe(413)
            expect(res.body).toEqual({
                code: 'PAYLOAD_TOO_LARGE',
                message: 'Request body too large',
                requestId: res.headers['x-request-id'],
            })
        }
    })

    it('stops reading a chunked body without content-length at the limit', async () => {
        const { port } = t.app.getHttpServer().address() as AddressInfo
        const status = await new Promise<number>((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/api/v1/notes',
                    headers: {
                        'content-type': 'application/json',
                        'transfer-encoding': 'chunked',
                    },
                },
                res => {
                    res.resume()
                    resolve(res.statusCode ?? 0)
                },
            )
            // The server may close the socket while we still write: only the answer matters.
            req.on('error', reject)
            req.write('{"title":"t","body":"')
            const chunk = 'x'.repeat(64 * 1024)
            for (let sent = 0; sent < 2 * MiB; sent += chunk.length) req.write(chunk)
            req.end('"}')
        })
        expect(status).toBe(413)
    })
})
