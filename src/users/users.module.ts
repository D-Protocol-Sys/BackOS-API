import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuthModule } from '../auth/auth.module';
import { PlatformAccessModule } from '../platforms/platform-access.module';

@Module({

    imports: [
        AuthModule,
        PlatformAccessModule,
    ],

    controllers: [UsersController],

    providers: [UsersService],

    exports: [UsersService],

})

export class UsersModule {}
