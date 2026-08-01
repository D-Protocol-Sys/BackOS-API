import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

export const GENERATION_QUEUE_NAME = 'platform-generation';

@Module({
    imports: [
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
        BullModule.registerQueue({ name: GENERATION_QUEUE_NAME }),
    ],
    exports: [BullModule],
})

export class GeneratorQueueModule {}
