import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common'
import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'
import { PG_BOSS } from '../common/jobs/jobs.module.js'
import type { Tx } from '../db/types.js'
import { NotesRepository } from './notes.repository.js'

export const REFRESH_STATS_QUEUE = 'notes.refresh-stats'

/**
 * Example of a background job (pg-boss): this service's own work that should
 * not hold up the request. `request(tx)` queues it in the transaction of the
 * write, so a rolled-back note queues nothing. A schedule every minute keeps
 * `createdLastHour` sliding without writes. `stately`: at most one queued and
 * one active job, extra sends are dropped.
 */
@Injectable()
export class NoteStatsJob implements OnModuleInit, OnApplicationBootstrap {
    private readonly logger = new Logger('NoteStatsJob')

    constructor(
        @Inject(PG_BOSS) private readonly boss: PgBoss,
        private readonly repository: NotesRepository,
    ) {}

    /** The queue exists before the first request can send to it. */
    async onModuleInit() {
        await this.boss.createQueue(REFRESH_STATS_QUEUE, {
            policy: 'stately',
            retryLimit: 5,
            retryDelay: 2,
            retryBackoff: true,
            expireInSeconds: 60,
        })
    }

    async onApplicationBootstrap() {
        await this.boss.work(
            REFRESH_STATS_QUEUE,
            {
                pollingIntervalSeconds: 1,
            },
            async ([job]) => {
                await this.repository.refreshStats()
                this.logger.log(
                    {
                        jobId: job?.id,
                    },
                    'Note stats refreshed',
                )
            },
        )
        await this.boss.schedule(REFRESH_STATS_QUEUE, '* * * * *')
    }

    /** Queues a refresh that commits or rolls back with `tx`. */
    async request(tx: Tx) {
        await this.boss.send(
            REFRESH_STATS_QUEUE,
            {},
            {
                db: fromDrizzle(tx, sql),
            },
        )
    }
}
