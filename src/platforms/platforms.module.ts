import { Module } from '@nestjs/common';
import { PlatformsService } from './platforms.service';
import { PlatformsController } from './platforms.controller';
import { MessagesModule } from '../messages/messages.module';

@Module({

    imports: [MessagesModule],

    controllers: [PlatformsController],

    providers: [PlatformsService],

})

export class PlatformsModule {}
