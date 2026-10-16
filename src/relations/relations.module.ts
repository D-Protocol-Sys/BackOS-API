import { Module } from '@nestjs/common';
import { PlatformAccessModule } from '../platforms/platform-access.module';
import { RelationsService } from './relations.service';
import { RelationsController } from './relations.controller';

@Module({
    imports: [PlatformAccessModule],

    controllers: [RelationsController],

    providers: [RelationsService],

    exports: [RelationsService],
})
export class RelationsModule {}
