import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { DB } from '../common/database/database.js'
import type { Envelope } from '../common/messaging/event.js'
import { processOnce } from '../common/messaging/inbox.js'
import { PermanentError, RabbitMq } from '../common/messaging/rabbitmq.js'
import { defineQueue } from '../common/messaging/topology.js'
import type { Db } from '../db/types.js'
import { NOTES_PRODUCER, noteCreatedV1 } from '../notes/notes.events.js'
import { ActivityRepository } from './activity.repository.js'

/** The consumer's own queue, bound to the events it needs. */
export const activityQueue = defineQueue('nest-example.activity', [
    {
        producer: NOTES_PRODUCER,
        types: [
            noteCreatedV1.type,
        ],
    },
])

/**
 * Example consumer: `notes.note.created.v1` → the inbox row and the feed entry
 * in one transaction, so a redelivered event changes nothing. Database work
 * only: slow or external work (e-mail, HTTP) would be a pg-boss job sent from
 * this transaction instead.
 */
@Injectable()
export class ActivityConsumer implements OnApplicationBootstrap {
    private readonly logger = new Logger('ActivityConsumer')

    constructor(
        @Inject(DB) private readonly db: Db,
        private readonly repository: ActivityRepository,
        private readonly rabbit: RabbitMq,
    ) {}

    async onApplicationBootstrap() {
        await this.rabbit.subscribe(activityQueue, async event => {
            await this.handle(event)
        })
    }

    async handle(envelope: Envelope): Promise<'processed' | 'duplicate'> {
        const parsed = noteCreatedV1.schema.safeParse(envelope)
        if (!parsed.success) throw new PermanentError('invalid payload')
        const event = parsed.data
        const outcome = await processOnce(
            this.db,
            {
                consumer: activityQueue.name,
                eventId: event.eventId,
                type: event.type,
            },
            tx =>
                this.repository.insert(tx, {
                    type: event.type,
                    subjectId: event.payload.noteId,
                    summary: event.payload.title,
                    occurredAt: new Date(event.occurredAt),
                }),
        )
        if (outcome === 'duplicate') {
            this.logger.log(
                {
                    eventId: event.eventId,
                },
                'Duplicate event ignored',
            )
        }
        return outcome
    }
}
