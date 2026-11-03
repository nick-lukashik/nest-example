import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { appConfig, dbConfig, notesConfig, rabbitConfig, redisConfig } from './config.js'
import { envSchema } from './env.js'

/**
 * Global, validated configuration: the Zod schema runs at startup and the
 * process stops on any invalid variable. Inject a group with
 * `@Inject(notesConfig.KEY) config: ConfigType<typeof notesConfig>`.
 */
@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            cache: true,
            // main.ts / node --env-file load .env; the module never reads files.
            ignoreEnvFile: true,
            validationSchema: envSchema,
            load: [
                appConfig,
                dbConfig,
                redisConfig,
                rabbitConfig,
                notesConfig,
            ],
        }),
    ],
})
export class AppConfigModule {}
