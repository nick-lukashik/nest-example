import { z } from 'zod'

/** The API contract of `notes`; OpenAPI is generated from these schemas. */
export const noteSchema = z
    .object({
        id: z.uuid(),
        title: z.string(),
        body: z.string(),
        createdAt: z.iso.datetime(),
    })
    .meta({
        id: 'Note',
    })
export type Note = z.infer<typeof noteSchema>

// Strict: an unknown or misspelled field is a client error, not silently dropped.
export const createNoteSchema = z
    .strictObject({
        title: z.string().trim().min(1).max(200),
        body: z.string().max(5000).default(''),
    })
    .meta({
        id: 'CreateNote',
    })
export type CreateNote = z.output<typeof createNoteSchema>

export const listNotesQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    /** Opaque: `nextCursor` of the previous page. */
    cursor: z.string().min(1).max(256).optional(),
})
export type ListNotesQuery = z.output<typeof listNotesQuerySchema>

export const noteListSchema = z
    .object({
        items: z.array(noteSchema),
        nextCursor: z.string().nullable(),
    })
    .meta({
        id: 'NoteList',
    })
export type NoteList = z.infer<typeof noteListSchema>

export const noteStatsSchema = z
    .object({
        total: z.number().int().nonnegative(),
        createdLastHour: z.number().int().nonnegative(),
    })
    .meta({
        id: 'NoteStats',
    })
export type NoteStats = z.infer<typeof noteStatsSchema>

/** What a cursor carries: the keyset position of the last item of a page. */
export const notesCursorSchema = z.object({
    createdAt: z.iso.datetime(),
    id: z.uuid(),
})
