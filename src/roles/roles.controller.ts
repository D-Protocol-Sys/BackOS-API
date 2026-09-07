import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * REST Controller providing administrative endpoints for managing system and custom roles,
 * along with their assigned permission sets.
 */
@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('roles')
export class RolesController {
    
    constructor(private readonly rolesService: RolesService) {}

    /**
     * Lists all system and custom roles with their associated permissions.
     * Requires `ROLES_READ` permission.
     * @route GET /roles
     */
    @RequirePermissions(PERMISSIONS.ROLES_READ)
    @Get()
    list() {
        return this.rolesService.list();
    }

    /**
     * Retrieves detailed information about a specific role by ID.
     * Requires `ROLES_READ` permission.
     * @route GET /roles/:id
     */
    @RequirePermissions(PERMISSIONS.ROLES_READ)
    @Get(':id')
    getById(@Param('id') id: string) {
        return this.rolesService.getById(id);
    }

    /**
     * Creates a new role with assigned permissions.
     * Requires `ROLES_CREATE` permission.
     * @route POST /roles
     */
    @RequirePermissions(PERMISSIONS.ROLES_CREATE)
    @Post()
    create(@CurrentUser() actor: { userId: string }, @Body() dto: CreateRoleDto) {
        return this.rolesService.create(actor.userId, dto);
    }

    /**
     * Updates role metadata (e.g., name, description).
     * Requires `ROLES_UPDATE` permission.
     * @route PATCH /roles/:id
     */
    @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
    @Patch(':id')
    update(
        @CurrentUser() actor: { userId: string },
        @Param('id') id: string,
        @Body() dto: UpdateRoleDto,
    ) {
        return this.rolesService.update(actor.userId, id, dto);
    }

    /**
     * Replaces the complete set of permissions assigned to a role.
     * Requires `ROLES_UPDATE` permission.
     *
     * SECURITY: the acting user must already hold every permission key being assigned
     * (enforced in `RolesService.replacePermissions`) - this is what prevents a
     * ROLES_UPDATE holder from silently granting themselves permissions they never had.
     *
     * @route PUT /roles/:id/permissions
     */
    @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
    @Put(':id/permissions')
    replacePermissions(
        @CurrentUser() actor: { userId: string },
        @Param('id') id: string,
        @Body() dto: ReplaceRolePermissionsDto,
    ) {
        return this.rolesService.replacePermissions(actor.userId, id, dto.permissionKeys);
    }

    /**
     * Deletes a custom role by ID.
     * Requires `ROLES_DELETE` permission.
     * @route DELETE /roles/:id
     */
    @RequirePermissions(PERMISSIONS.ROLES_DELETE)
    @Delete(':id')
    delete(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
        return this.rolesService.delete(actor.userId, id);
    }
}