import { Module } from '@nestjs/common';
import { RelationsService } from './relations.service';
import { RelationsController } from './relations.controller';

@Module({

    controllers: [RelationsController],

    providers: [RelationsService],

    exports: [RelationsService],

})

export class RelationsModule {}
