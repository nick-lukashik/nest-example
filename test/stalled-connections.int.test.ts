import net from 'node:net'
import { expect, it } from 'vitest'
import { createPool, databaseFailure } from '../src/common/database/database.js'
import { bounded, createRedisClient } from '../src/common/redis/redis.client.js'

/** A peer that keeps TCP open but withholds replies, unlike a refused connection. */
async function peer(handle: (socket: net.Socket) => void) {
    const sockets = new Set<net.Socket>()
    const server = net.createServer(socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
        handle(socket)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as net.AddressInfo).port
    return {
        port,
        async close() {
            for (const socket of sockets) socket.destroy()
            await new Promise<void>(resolve => server.close(() => resolve()))
        },
    }
}

it('settles abandoned Redis commands and reconnects without replaying them', async () => {
    let stalled = false
    let closed = 0
    let writes = 0
    const server = await peer(socket => {
        socket.on('close', () => closed++)
        socket.on('data', data => {
            const text = data.toString()
            writes += (text.match(/INCR/g) ?? []).length
            if (!stalled) socket.write('+OK\r\n'.repeat((text.match(/\*\d+\r\n/g) ?? []).length))
        })
    })
    const client = createRedisClient({
        url: `redis://127.0.0.1:${server.port}`,
        name: 'stalled-test',
        keyPrefix: 'test:',
    })
    client.on('error', () => {})
    try {
        await client.connect()
        stalled = true
        let settled = 0
        await Promise.all(
            Array.from(
                {
                    length: 300,
                },
                () => {
                    const command = client.incr('counter')
                    void command.then(
                        () => settled++,
                        () => settled++,
                    )
                    return bounded(client, command).catch(() => {})
                },
            ),
        )
        await expect.poll(() => settled).toBe(300)
        await expect.poll(() => closed).toBeGreaterThan(0)
        // The connection's own reply queue, not just the caller, is bounded.
        expect(writes).toBeLessThanOrEqual(256)
        const beforeRecovery = writes
        stalled = false
        await expect
            .poll(async () => bounded(client, client.ping()).catch(() => 'down'), {
                timeout: 10_000,
            })
            .toBe('OK')
        expect(writes).toBe(beforeRecovery)
    } finally {
        client.destroy()
        await server.close()
    }
}, 20_000)

it.each([
    'pool',
    'transaction',
] as const)(
    'removes a stalled PostgreSQL connection used by %s',
    async mode => {
        let stalled = true
        const server = await peer(socket => {
            let started = false
            socket.on('data', () => {
                if (!started) {
                    started = true
                    // AuthenticationOk, ReadyForQuery.
                    socket.write(
                        Buffer.from([
                            82,
                            0,
                            0,
                            0,
                            8,
                            0,
                            0,
                            0,
                            0,
                            90,
                            0,
                            0,
                            0,
                            5,
                            73,
                        ]),
                    )
                } else if (!stalled) {
                    // CommandComplete SELECT 0, ReadyForQuery.
                    socket.write(
                        Buffer.concat([
                            Buffer.from([
                                67,
                                0,
                                0,
                                0,
                                13,
                            ]),
                            Buffer.from('SELECT 0\0'),
                            Buffer.from([
                                90,
                                0,
                                0,
                                0,
                                5,
                                73,
                            ]),
                        ]),
                    )
                }
            })
        })
        const pool = createPool({
            url: `postgres://test:test@127.0.0.1:${server.port}/test`,
            max: 1,
            applicationName: 'stalled-test',
        })
        pool.on('error', () => {})
        try {
            const client = mode === 'transaction' ? await pool.connect() : undefined
            const failure = await (client ?? pool).query('select 1').catch(error => error)
            client?.release()
            expect(databaseFailure(failure)).toBe('unavailable')
            await expect.poll(() => pool.totalCount).toBe(0)
            stalled = false
            expect((await pool.query('select 1')).rows).toEqual([])
            expect(pool.idleCount).toBe(1)
        } finally {
            await server.close()
            await pool.end()
        }
    },
    15_000,
)
