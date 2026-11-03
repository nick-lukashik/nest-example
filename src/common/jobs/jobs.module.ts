import {
    type BeforeApplicationShutdown,
    type DynamicModule,
    Global,
    Inject,
    Injectable,
    type InjectionToken,
    Logger,
    Module,
} from '@nestjs/common'
import { PgBoss } from 'pg-boss'

/** Injection token: `@Inject(PG_BOSS) boss: PgBoss`. */
export const PG_BOSS = Symbol('PG_BOSS')

export type JobsOptions = {
    connectionString: string
    applicationName: string
    /** pg-boss keeps its own small pool. */
    max?: number
    /** How long `stop()` waits for running jobs on shutdown. */
    stopTimeoutMs?: number
}

const JOBS_OPTIONS = Symbol('JOBS_OPTIONS')
const STOP_TIMEOUT_MS = Symbol('STOP_TIMEOUT_MS')

@Injectable()
class JobsLifecycle implements BeforeApplicationShutdown {
    private readonly logger = new Logger('PgBoss')

    constructor(
        @Inject(PG_BOSS) private readonly boss: PgBoss,
        @Inject(STOP_TIMEOUT_MS) private readonly timeoutMs: number,
    ) {}

    /** Stops fetching, waits for active jobs, closes the pool; the app pool is still open. */
    async beforeApplicationShutdown() {
        await this.boss.stop({
            graceful: true,
            timeout: this.timeoutMs,
        })
        this.logger.log('pg-boss stopped')
    }
}

/**
 * pg-boss for jobs inside the service (schema `pgboss`, created and migrated
 * on start and by `dist/db/migrate.js`). Queues are created and workers
 * registered by the feature modules.
 */
@Global()
@Module({})
export class JobsModule {
    static forRootAsync(options: {
        inject?: InjectionToken[]
        useFactory: (...args: never[]) => JobsOptions
    }): DynamicModule {
        const logger = new Logger('PgBoss')
        return {
            module: JobsModule,
            providers: [
                {
                    provide: JOBS_OPTIONS,
                    inject: options.inject ?? [],
                    useFactory: options.useFactory,
                },
                {
                    provide: PG_BOSS,
                    inject: [
                        JOBS_OPTIONS,
                    ],
                    useFactory: async (jobs: JobsOptions) => {
                        const boss = new PgBoss({
                            connectionString: jobs.connectionString,
                            application_name: jobs.applicationName,
                            max: jobs.max ?? 4,
                            schema: 'pgboss',
                        })
                        boss.on('error', (error: Error) =>
                            logger.error(
                                {
                                    err: error.message,
                                },
                                'pg-boss error',
                            ),
                        )
                        boss.on('warning', (warning: { message: string }) =>
                            logger.warn(
                                {
                                    warning: warning.message,
                                },
                                'pg-boss warning',
                            ),
                        )
                        await boss.start()
                        return boss
                    },
                },
                {
                    provide: STOP_TIMEOUT_MS,
                    inject: [
                        JOBS_OPTIONS,
                    ],
                    // Fits the 25 s shutdown budget (see main.ts) with the consumer drain.
                    useFactory: (jobs: JobsOptions) => jobs.stopTimeoutMs ?? 10_000,
                },
                JobsLifecycle,
            ],
            exports: [
                PG_BOSS,
            ],
        }
    }
}
