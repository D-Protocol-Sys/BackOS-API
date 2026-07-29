import { Module } from '@nestjs/common';
import { FieldsService } from './fields.service';
import { FieldsController } from './fields.controller';

@Module({

    controllers: [FieldsController],

    providers: [FieldsService],

})

export class FieldsModule {}
