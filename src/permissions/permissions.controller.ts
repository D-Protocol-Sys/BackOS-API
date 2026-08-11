import { Controller, Get } from '@nestjs/common';
import { PermissionsService } from './permissions.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * REST Controller exposing administrative endpoints for permissions management.
 * Integrated with OpenAPI (Swagger) documentation and protected by bearer authentication.
 */
@ApiTags('Permissions')
@ApiBearerAuth('access-token')
@Controller('permissions')
export class PermissionsController {
    constructor(private readonly permissionsService: PermissionsService) {}

    /**
     * Endpoint retrieving the master catalog of all available permissions.
     * Protected by custom authorization metadata requiring `PERMISSIONS_READ` permission.
     * * @route GET /permissions
     * @returns Array of all permissions sorted by key.
     */
    @RequirePermissions(PERMISSIONS.PERMISSIONS_READ)
    @Get()
    listAll() {
        return this.permissionsService.listAll();
    }
}