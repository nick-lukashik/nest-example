import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Res, UseGuards } from '@nestjs/common'
import { ApiCreatedResponse, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger'
import { ThrottlerGuard } from '@nestjs/throttler'
import type { Response } from 'express'
import { ApiErrors } from '../common/openapi/openapi.js'
import {
    type CreateNote,
    createNoteSchema,
    type ListNotesQuery,
    listNotesQuerySchema,
    noteListSchema,
    noteSchema,
    noteStatsSchema,
} from './notes.schemas.js'
import { NotesService } from './notes.service.js'

/** Thin: validation by schema on the parameter, the rest in NotesService. */
@ApiTags('notes')
@ApiHeader({
    name: 'x-request-id',
    required: false,
    description: 'Echoed back; generated when absent',
})
@Controller('notes')
export class NotesController {
    constructor(private readonly notes: NotesService) {}

    @Get()
    @ApiOperation({
        summary: 'Newest notes first, cursor pagination (cached in Redis)',
    })
    @ApiOkResponse({
        standardSchema: noteListSchema,
    })
    @ApiErrors(400)
    async list(
        @Query({
            schema: listNotesQuerySchema,
        })
        query: ListNotesQuery,
        @Res({
            passthrough: true,
        })
        res: Response,
    ) {
        const { value, hit } = await this.notes.list(query)
        res.setHeader('x-cache', hit ? 'HIT' : 'MISS')
        return value
    }

    // Declared before ":id" so that "stats" is not taken for an id.
    @Get('stats')
    @ApiOperation({
        summary: 'Counters maintained by the event → job pipeline',
    })
    @ApiOkResponse({
        standardSchema: noteStatsSchema,
    })
    @ApiErrors()
    stats() {
        return this.notes.stats()
    }

    @Get(':id')
    @ApiOkResponse({
        standardSchema: noteSchema,
    })
    @ApiErrors(404)
    get(@Param('id') id: string) {
        return this.notes.get(id)
    }

    @Post()
    @HttpCode(HttpStatus.CREATED)
    @UseGuards(ThrottlerGuard)
    @ApiOperation({
        summary: 'Create a note; publishes notes.note.created.v1',
    })
    @ApiCreatedResponse({
        standardSchema: noteSchema,
    })
    @ApiErrors(400, 413, 429)
    create(
        @Body({
            schema: createNoteSchema,
        })
        body: CreateNote,
    ) {
        return this.notes.create(body)
    }
}
