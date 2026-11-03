import { Module } from '@nestjs/common'
import { NoteStatsJob } from './note-stats.job.js'
import { NotesController } from './notes.controller.js'
import { NotesRepository } from './notes.repository.js'
import { NotesService } from './notes.service.js'

/** Example feature: HTTP API, Redis cache and rate limit, an outbox event, a pg-boss job. */
@Module({
    controllers: [
        NotesController,
    ],
    providers: [
        NotesRepository,
        NotesService,
        NoteStatsJob,
    ],
})
export class NotesModule {}
