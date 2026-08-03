import { Controller, Get } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Permissions')
@ApiBearerAuth('access-token')
@Controller('permissions')
export class PermissionsController {
    constructor(private readonly permissionsService: PermissionsService) {}

    @RequirePermissions(PERMISSIONS.PERMISSIONS_READ)
    @Get()
    listAll() {
        return this.permissionsService.listAll();
    }
}