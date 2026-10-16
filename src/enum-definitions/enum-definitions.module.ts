import { Module } from '@nestjs/common';
import { PlatformAccessModule } from '../platforms/platform-access.module';
import { EnumDefinitionsController } from './enum-definitions.controller';
import { EnumDefinitionsService } from './enum-definitions.service';

@Module({
    imports: [PlatformAccessModule],
    controllers: [EnumDefinitionsController],
    providers: [EnumDefinitionsService],
    exports: [EnumDefinitionsService],
})
export class EnumDefinitionsModule {}
