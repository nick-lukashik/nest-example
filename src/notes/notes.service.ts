import { Inject, Injectable } from '@nestjs/common'
import type { ConfigType } from '@nestjs/config'
import { z } from 'zod'
import { DB } from '../common/database/database.js'
import { notFound } from '../common/http/app-error.js'
import { cursorCodec } from '../common/http/cursor.js'
import { enqueueEvent } from '../common/messaging/outbox.js'
import { OutboxRelay } from '../common/messaging/outbox-relay.js'
import { type Cached, VersionedCache } from '../common/redis/versioned-cache.js'
import { notesConfig } from '../config/config.js'
import type { Db, NoteRow } from '../db/types.js'
import { NoteStatsJob } from './note-stats.job.js'
import { noteCreatedV1 } from './notes.events.js'
import { NotesRepository } from './notes.repository.js'
import {
    type CreateNote,
    type ListNotesQuery,
    type Note,
    type NoteList,
    type NoteStats,
    noteListSchema,
    notesCursorSchema,
} from './notes.schemas.js'

/** Redis namespace of cached list pages; bumped on every create. */
const LIST_CACHE = 'notes:list'
const cursor = cursorCodec(notesCursorSchema)
const uuid = z.uuid()

const toNote = (row: NoteRow): Note => ({
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
})

@Injectable()
export class NotesService {
    constructor(
        @Inject(DB) private readonly db: Db,
        private readonly repository: NotesRepository,
        private readonly cache: VersionedCache,
        private readonly relay: OutboxRelay,
        private readonly statsJob: NoteStatsJob,
        @Inject(notesConfig.KEY)
        private readonly config: ConfigType<typeof notesConfig>,
    ) {}

    /**
     * The note commits together with two independent follow-ups: the
     * `notes.note.created.v1` event for other services (outbox → RabbitMQ) and
     * this service's own stats job (pg-boss). Neither waits for the other.
     */
    async create(input: CreateNote): Promise<Note> {
        const row = await this.db.transaction(async tx => {
            const note = await this.repository.insert(tx, input)
            await this.statsJob.request(tx)
            await enqueueEvent(
                tx,
                noteCreatedV1.create({
                    aggregateId: note.id,
                    payload: {
                        noteId: note.id,
                        title: note.title,
                        createdAt: note.createdAt.toISOString(),
                    },
                }),
            )
            return note
        })
        this.relay.kick()
        await this.cache.invalidate(LIST_CACHE)
        return toNote(row)
    }

    /** A malformed id cannot exist: 404 like any other missing note. */
    async get(id: string): Promise<Note> {
        const row = uuid.safeParse(id).success ? await this.repository.findById(id) : undefined
        if (!row) throw notFound('Note')
        return toNote(row)
    }

    async list(query: ListNotesQuery): Promise<Cached<NoteList>> {
        // Decoded before the cache: a forged cursor is a 400 even when cached pages exist.
        const after = query.cursor ? cursor.decode(query.cursor) : undefined
        return this.cache.remember(
            LIST_CACHE,
            `${query.limit}:${query.cursor ?? 'first'}`,
            {
                ttlSeconds: this.config.cacheTtlSeconds,
                schema: noteListSchema,
            },
            async () => {
                const rows = await this.repository.page(query.limit, after)
                const items = rows.slice(0, query.limit).map(toNote)
                const last = items.at(-1)
                return {
                    items,
                    nextCursor:
                        rows.length > query.limit && last
                            ? cursor.encode({
                                  createdAt: last.createdAt,
                                  id: last.id,
                              })
                            : null,
                }
            },
        )
    }

    /** Maintained asynchronously by the `notes.refresh-stats` job. */
    async stats(): Promise<NoteStats> {
        const row = await this.repository.readStats()
        return {
            total: row?.total ?? 0,
            createdLastHour: row?.createdLastHour ?? 0,
        }
    }
}
