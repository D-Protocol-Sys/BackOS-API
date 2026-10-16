import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * Unique identifier for the BullMQ queue responsible for processing background generation jobs.
 */
export const GENERATION_QUEUE_NAME = 'platform-generation';

/**
 * QUEUE-003: finished jobs used to stay in Redis forever (BullMQ keeps them by default). The
 * generation's own record in PostgreSQL is the durable history; Redis only keeps recent jobs.
 */
export const GENERATION_JOB_RETENTION = {
    removeOnComplete: { age: 7 * 24 * 3600, count: 1000 },
    removeOnFail: { age: 30 * 24 * 3600, count: 5000 },
} as const;

/**
 * Module establishing the BullMQ infrastructure using Redis as the transport engine.
 *
 * CONFIG FIX (QUEUE-001): every containerized stack starts Redis with `--requirepass`, but the
 * connection never sent a password, so every command failed with NOAUTH. `REDIS_PASSWORD`
 * (and optionally `REDIS_USERNAME` for ACL users, `REDIS_TLS=true`) are now passed through.
 */
@Module({
    imports: [
        BullModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                const password = configService.get<string>('REDIS_PASSWORD') || undefined;
                const username = configService.get<string>('REDIS_USERNAME') || undefined;
                const tls = String(configService.get<string | boolean>('REDIS_TLS', false)) === 'true';
                return {
                    connection: {
                        host: configService.get<string>('REDIS_HOST', 'localhost'),
                        port: configService.get<number>('REDIS_PORT', 6379),
                        ...(password ? { password } : {}),
                        ...(username ? { username } : {}),
                        ...(tls ? { tls: {} } : {}),
                    },
                };
            },
        }),
        BullModule.registerQueue({ name: GENERATION_QUEUE_NAME }),
    ],
    exports: [BullModule],
})
export class GeneratorQueueModule {}
