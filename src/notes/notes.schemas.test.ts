import { describe, expect, it } from 'vitest'
import { createNoteSchema, listNotesQuerySchema } from './notes.schemas.js'

describe('notes schemas', () => {
    it('trims the title and defaults the body', () => {
        expect(
            createNoteSchema.parse({
                title: '  Hi  ',
            }),
        ).toEqual({
            title: 'Hi',
            body: '',
        })
    })

    it.each([
        [
            {
                title: '',
            },
            'title',
        ],
        [
            {
                title: '   ',
            },
            'title',
        ],
        [
            {
                title: 'x'.repeat(201),
            },
            'title',
        ],
        [
            {
                title: 'ok',
                body: 'x'.repeat(5001),
            },
            'body',
        ],
        [
            {},
            'title',
        ],
    ])('rejects %j at %s', (input, path) => {
        const result = createNoteSchema.safeParse(input)
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.path).toEqual([
            path,
        ])
    })

    it('rejects unknown fields', () => {
        const result = createNoteSchema.safeParse({
            title: 'ok',
            tilte: 'typo',
        })
        expect(result.success).toBe(false)
        expect(result.error?.issues[0]?.code).toBe('unrecognized_keys')
    })

    it('coerces and bounds the page size', () => {
        expect(listNotesQuerySchema.parse({})).toEqual({
            limit: 20,
        })
        expect(
            listNotesQuerySchema.parse({
                limit: '5',
            }).limit,
        ).toBe(5)
        expect(
            listNotesQuerySchema.safeParse({
                limit: '101',
            }).success,
        ).toBe(false)
        expect(
            listNotesQuerySchema.safeParse({
                limit: '1.5',
            }).success,
        ).toBe(false)
    })
})
