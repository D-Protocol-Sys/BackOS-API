import { Module } from '@nestjs/common';
import { PlatformsService } from './platforms.service';
import { PlatformsController } from './platforms.controller';
import { MessagesModule } from '../messages/messages.module';
import { GeneratorModule } from '../generator/generator.module';

@Module({

    // GeneratorModule gives PlatformsService access to DockerRuntimeManagerService (stop a
    // platform's runtime when it's archived/purged) and ProjectScaffolderService (remove its
    // generated project directory when it's permanently deleted).
    imports: [MessagesModule, GeneratorModule],

    controllers: [PlatformsController],

    providers: [PlatformsService],

    exports: [PlatformsService],

})

export class PlatformsModule {}
