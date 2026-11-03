import { Inject, Injectable } from '@nestjs/common'
import { desc } from 'drizzle-orm'
import { DB } from '../common/database/database.js'
import { activity } from '../db/schema.js'
import type { Db, NewActivity, Tx } from '../db/types.js'

@Injectable()
export class ActivityRepository {
    constructor(@Inject(DB) private readonly db: Db) {}

    async insert(tx: Tx, entry: NewActivity) {
        await tx.insert(activity).values(entry)
    }

    latest(limit: number) {
        return this.db.select().from(activity).orderBy(desc(activity.occurredAt), desc(activity.id)).limit(limit)
    }
}
