import { Module } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { ThrottlerModule } from '@nestjs/throttler'
import { ActivityModule } from './activity/activity.module.js'
import { DatabaseModule } from './common/database/database.module.js'
import { HealthModule } from './common/health/health.module.js'
import { JobsModule } from './common/jobs/jobs.module.js'
import { createLoggerModule } from './common/logging/logger.module.js'
import { MessagingModule } from './common/messaging/messaging.module.js'
import { eventsExchange } from './common/messaging/topology.js'
import { MetricsModule } from './common/metrics/metrics.module.js'
import { RedisModule } from './common/redis/redis.module.js'
import { RedisThrottlerStorage } from './common/redis/redis-throttler.storage.js'
import { appConfig, dbConfig, rabbitConfig, redisConfig } from './config/config.js'
import { AppConfigModule } from './config/config.module.js'
import * as schema from './db/schema.js'
import { NOTES_PRODUCER } from './notes/notes.events.js'
import { NotesModule } from './notes/notes.module.js'

type App = ConfigType<typeof appConfig>

@Module({
    imports: [
        AppConfigModule,
        createLoggerModule({
            inject: [
                appConfig.KEY,
            ],
            useFactory: (app: App) => ({
                service: app.service,
                version: app.version,
                level: app.logLevel,
            }),
        }),
        HealthModule.forRootAsync({
            inject: [
                appConfig.KEY,
            ],
            useFactory: (app: App) => ({
                shutdownDelayMs: app.shutdownDelayMs,
            }),
        }),
        MetricsModule.forRootAsync({
            inject: [
                appConfig.KEY,
            ],
            useFactory: (app: App) => ({
                service: app.service,
                version: app.version,
                port: app.metricsPort,
            }),
        }),
        DatabaseModule.forRootAsync({
            schema,
            inject: [
                dbConfig.KEY,
                appConfig.KEY,
            ],
            useFactory: (db: ConfigType<typeof dbConfig>, app: App) => ({
                url: db.url,
                max: db.max,
                applicationName: app.service,
            }),
        }),
        RedisModule.forRootAsync({
            inject: [
                redisConfig.KEY,
                appConfig.KEY,
            ],
            useFactory: (redis: ConfigType<typeof redisConfig>, app: App) => ({
                url: redis.url,
                name: app.service,
                keyPrefix: `${app.service}:`,
            }),
        }),
        MessagingModule.forRootAsync({
            inject: [
                rabbitConfig.KEY,
                appConfig.KEY,
            ],
            useFactory: (rabbit: ConfigType<typeof rabbitConfig>, app: App) => ({
                url: rabbit.url,
                connectionName: app.service,
                exchanges: [
                    eventsExchange(NOTES_PRODUCER),
                ],
            }),
        }),
        JobsModule.forRootAsync({
            inject: [
                dbConfig.KEY,
                appConfig.KEY,
            ],
            useFactory: (db: ConfigType<typeof dbConfig>, app: App) => ({
                connectionString: db.url,
                applicationName: `${app.service}-jobs`,
            }),
        }),
        // Applied per route with @UseGuards(ThrottlerGuard); counters live in Redis.
        ThrottlerModule.forRootAsync({
            inject: [
                RedisThrottlerStorage,
                appConfig.KEY,
            ],
            useFactory: (storage: RedisThrottlerStorage, app: App) => ({
                throttlers: [
                    {
                        name: 'default',
                        ttl: 60_000,
                        limit: app.rateLimitPerMinute,
                    },
                ],
                storage,
            }),
        }),
        NotesModule,
        ActivityModule,
    ],
})
export class AppModule {}
