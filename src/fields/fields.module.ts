import { Module } from '@nestjs/common';
import { PlatformAccessModule } from '../platforms/platform-access.module';
import { FieldsService } from './fields.service';
import { FieldsController } from './fields.controller';

@Module({

    imports: [PlatformAccessModule],

    controllers: [FieldsController],

    providers: [FieldsService],

})

export class FieldsModule {}
