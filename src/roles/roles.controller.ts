import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { RolesService } from './roles.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { ReplaceRolePermissionsDto } from './dto/replace-role-permissions.dto';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Roles')
@ApiBearerAuth('access-token')
@Controller('roles')
export class RolesController {
    
    constructor(private readonly rolesService: RolesService) {}

    @RequirePermissions(PERMISSIONS.ROLES_READ)
    @Get()
    list() {
        return this.rolesService.list();
    }

    @RequirePermissions(PERMISSIONS.ROLES_READ)
    @Get(':id')
    getById(@Param('id') id: string) {
        return this.rolesService.getById(id);
    }

    @RequirePermissions(PERMISSIONS.ROLES_CREATE)
    @Post()
    create(@CurrentUser() actor: { userId: string }, @Body() dto: CreateRoleDto) {
        return this.rolesService.create(actor.userId, dto);
    }

    @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
    @Patch(':id')
    update(@Param('id') id: string, @Body() dto: UpdateRoleDto) {
        return this.rolesService.update(id, dto);
    }

    @RequirePermissions(PERMISSIONS.ROLES_UPDATE)
    @Put(':id/permissions')
    replacePermissions(
        @Param('id') id: string,
        @Body() dto: ReplaceRolePermissionsDto,
    ) {
        return this.rolesService.replacePermissions(id, dto.permissionKeys);
    }

    @RequirePermissions(PERMISSIONS.ROLES_DELETE)
    @Delete(':id')
    delete(@Param('id') id: string) {
        return this.rolesService.delete(id);
    }
}