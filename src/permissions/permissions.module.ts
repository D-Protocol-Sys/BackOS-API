import { Module } from '@nestjs/common';
import { PermissionsSyncService } from './permissions-sync.service';
import { PermissionsService } from './permissions.service';
import { PermissionsController } from './permissions.controller';

@Module({

    controllers: [PermissionsController],

    providers: [PermissionsSyncService, PermissionsService],

})

export class PermissionsModule {}
