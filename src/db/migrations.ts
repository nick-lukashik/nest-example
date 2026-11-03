import { fileURLToPath } from 'node:url'
import { PgBoss } from 'pg-boss'
import { type MigrationOptions, runMigrations } from '../common/database/database.js'

/** drizzle/ at the project root, from src/db or dist/db alike. */
export const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

/**
 * Applies this service's SQL migrations, then installs or upgrades the pg-boss
 * schema. pg-boss runs its own schema migrations with its own lock_timeout (30 s);
 * they change only with a pg-boss release that says so.
 */
export async function migrateDatabase(url: string, options?: MigrationOptions) {
    await runMigrations(url, migrationsFolder, options)
    const boss = new PgBoss({
        connectionString: url,
        schema: 'pgboss',
        max: 1,
        supervise: false,
        schedule: false,
    })
    await boss.start()
    await boss.stop({
        graceful: false,
    })
}
