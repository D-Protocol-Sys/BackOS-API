import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * Unique identifier for the BullMQ queue responsible for processing background generation jobs.
 */
export const GENERATION_QUEUE_NAME = 'platform-generation';

/**
 * Module establishing the BullMQ infrastructure using Redis as the transport engine.
 * Registers the main connection parameters and registers the specific work queue.
 */
@Module({
    imports: [
        // Asynchronously configures the global BullMQ connection using injected environment variables
        BullModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => ({
                connection: {
                    host: configService.get<string>('REDIS_HOST', 'localhost'),
                    port: configService.get<number>('REDIS_PORT', 6379),
                },
            }),
        }),
        // Registers the specific queue instance so it can be injected into producers via @InjectQueue()
        BullModule.registerQueue({ name: GENERATION_QUEUE_NAME }),
    ],
    // Exports BullModule so other modules importing GeneratorQueueModule gain access to the configured queues
    exports: [BullModule],
})

export class GeneratorQueueModule {}
