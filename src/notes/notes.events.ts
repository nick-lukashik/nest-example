import { z } from 'zod'
import { defineEvent } from '../common/messaging/event.js'

/** The producer name of this service's events: exchange `notes.events`. */
export const NOTES_PRODUCER = 'notes'

/** Public contract: other services subscribe to it (here: src/activity). */
export const noteCreatedV1 = defineEvent(
    'notes.note.created.v1',
    NOTES_PRODUCER,
    z.object({
        noteId: z.uuid(),
        title: z.string(),
        createdAt: z.iso.datetime(),
    }),
)
