import { Module } from '@nestjs/common';
import { PlatformsService } from './platforms.service';
import { PlatformsController } from './platforms.controller';
import { PlatformRolesService } from './platform-roles.service';
import { PlatformRolesController } from './platform-roles.controller';
import { PlatformAccessModule } from './platform-access.module';
import { MessagesModule } from '../messages/messages.module';
import { GeneratorModule } from '../generator/generator.module';

@Module({
    // GeneratorModule gives PlatformsService access to DockerRuntimeManagerService (stop a
    // platform's runtime when it's archived/purged) and ProjectScaffolderService (remove its
    // generated project directory when it's permanently deleted). PlatformAccessModule gives
    // PlatformsService/PlatformRolesService the shared "who can do what on this platform"
    // resolver - see PlatformAccessModule's doc comment for why it's its own module.
    imports: [MessagesModule, GeneratorModule, PlatformAccessModule],

    controllers: [PlatformsController, PlatformRolesController],

    providers: [PlatformsService, PlatformRolesService],

    exports: [PlatformsService],
})
export class PlatformsModule {}
