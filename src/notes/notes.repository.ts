import { Inject, Injectable } from '@nestjs/common'
import { desc, eq, sql } from 'drizzle-orm'
import { DB } from '../common/database/database.js'
import { noteStats, notes } from '../db/schema.js'
import type { Db, NoteRow, Tx } from '../db/types.js'
import type { CreateNote } from './notes.schemas.js'

/** SQL of the notes module; services never build queries themselves. */
@Injectable()
export class NotesRepository {
    constructor(@Inject(DB) private readonly db: Db) {}

    async insert(tx: Tx, input: CreateNote): Promise<NoteRow> {
        const [row] = await tx.insert(notes).values(input).returning()
        if (!row) throw new Error('insert into notes returned no row')
        return row
    }

    async findById(id: string): Promise<NoteRow | undefined> {
        const [row] = await this.db.select().from(notes).where(eq(notes.id, id)).limit(1)
        return row
    }

    /** Newest first, keyset pagination; one extra row tells whether a next page exists. */
    page(
        limit: number,
        after?: {
            createdAt: string
            id: string
        },
    ) {
        return this.db
            .select()
            .from(notes)
            .where(
                after
                    ? sql`(${notes.createdAt}, ${notes.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
                    : undefined,
            )
            .orderBy(desc(notes.createdAt), desc(notes.id))
            .limit(limit + 1)
    }

    /** Recomputes the single stats row (a full count: fine for a starter, swap for counters at scale). */
    async refreshStats() {
        await this.db.execute(sql`
      insert into ${noteStats} (id, total, created_last_hour, refreshed_at)
      select 1,
             count(*),
             count(*) filter (where ${notes.createdAt} > now() - interval '1 hour'),
             now()
        from ${notes}
      on conflict (id) do update
        set total = excluded.total,
            created_last_hour = excluded.created_last_hour,
            refreshed_at = excluded.refreshed_at`)
    }

    async readStats() {
        const [row] = await this.db.select().from(noteStats).limit(1)
        return row
    }
}
