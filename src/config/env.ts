import { z } from 'zod'
import {
    baseEnvSchema,
    defineEnv,
    metricsEnvSchema,
    postgresEnvSchema,
    rabbitEnvSchema,
    redisEnvSchema,
} from '../common/config/define-env.js'

/** Every variable this service reads. Nothing else touches process.env. */
export const envSchema = baseEnvSchema
    .extend(postgresEnvSchema.shape)
    .extend(redisEnvSchema.shape)
    .extend(rabbitEnvSchema.shape)
    .extend(metricsEnvSchema.shape)
    .extend({
        /** TTL of a cached notes page. */
        NOTES_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(3_600).default(60),
        /** Requests per client IP per minute on routes behind ThrottlerGuard (POST /notes). */
        RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(30),
    })

export type Env = z.output<typeof envSchema>

export const env = defineEnv(envSchema)
