import { Module } from '@nestjs/common'
import { ActivityConsumer } from './activity.consumer.js'
import { ActivityRepository } from './activity.repository.js'

/**
 * Example subscriber: a feed of what happened in other modules, built from
 * their events. It stands in for another service (its own queue and tables,
 * nothing imported but the event contract); it shares this process only to
 * keep the example runnable on its own.
 */
@Module({
    providers: [
        ActivityRepository,
        ActivityConsumer,
    ],
})
export class ActivityModule {}
