import { Module } from '@nestjs/common';
import { PlatformAccessModule } from '../platforms/platform-access.module';
import { EntitiesService } from './entities.service';
import { EntitiesController } from './entities.controller';

@Module({
    imports: [PlatformAccessModule],

    controllers: [EntitiesController],

    providers: [EntitiesService],
})
export class EntitiesModule {}
