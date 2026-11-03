import { sql } from 'drizzle-orm'
import { bigint, check, index, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

// Platform tables every service with events carries: outbox and inbox.
export { inbox, outbox } from '../common/messaging/outbox.schema.js'

/** Millisecond precision, so an ISO string from JSON round-trips exactly (cursors). */
const at = (name: string) =>
    timestamp(name, {
        withTimezone: true,
        precision: 3,
    })

export const notes = pgTable(
    'notes',
    {
        // PostgreSQL 18 built-in: time-ordered ids, index-friendly.
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        title: text('title').notNull(),
        body: text('body').notNull().default(''),
        createdAt: at('created_at').notNull().defaultNow(),
    },
    t => [
        index('notes_created_at_id_idx').on(t.createdAt.desc(), t.id.desc()),
        check('notes_title_length', sql`char_length(${t.title}) between 1 and 200`),
        check('notes_body_length', sql`char_length(${t.body}) <= 5000`),
    ],
)

/** One row, maintained by the `notes.refresh-stats` job (pg-boss). */
export const noteStats = pgTable(
    'note_stats',
    {
        id: smallint('id').primaryKey().default(1),
        total: bigint('total', {
            mode: 'number',
        }).notNull(),
        createdLastHour: bigint('created_last_hour', {
            mode: 'number',
        }).notNull(),
        refreshedAt: at('refreshed_at').notNull().defaultNow(),
    },
    t => [
        check('note_stats_single_row', sql`${t.id} = 1`),
    ],
)

/** Feed built by the `notes.note.created.v1` consumer (src/activity). */
export const activity = pgTable(
    'activity',
    {
        id: uuid('id').primaryKey().default(sql`uuidv7()`),
        /** The event type it came from. */
        type: text('type').notNull(),
        subjectId: uuid('subject_id').notNull(),
        summary: text('summary').notNull(),
        occurredAt: at('occurred_at').notNull(),
        recordedAt: at('recorded_at').notNull().defaultNow(),
    },
    t => [
        index('activity_occurred_at_id_idx').on(t.occurredAt.desc(), t.id.desc()),
    ],
)
