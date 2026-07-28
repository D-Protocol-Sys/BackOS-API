import { Controller, Get } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';

@Controller('permissions')
export class PermissionsController {
    constructor(private readonly permissionsService: PermissionsService) {}

    @RequirePermissions(PERMISSIONS.PERMISSIONS_READ)
    @Get()
    listAll() {
        return this.permissionsService.listAll();
    }
}