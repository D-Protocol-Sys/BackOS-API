import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    // ---- Profil personnel ----

    @Get('me')
    getMe(@CurrentUser() user: { userId: string }) {
        return this.usersService.getMe(user.userId);
    }

    @Patch('me')
    updateMe(
        @CurrentUser() user: { userId: string },
        @Body() dto: UpdateProfileDto,
    ) {
        return this.usersService.updateMe(user.userId, dto);
    }

    @Get('me/export')
    exportMe(@CurrentUser() user: { userId: string }) {
        return this.usersService.exportUserData(user.userId);
    }

    @Delete('me')
    deleteMe(@CurrentUser() user: { userId: string }) {
        return this.usersService.hardDeleteUser(user.userId, user.userId);
    }

    // ---- Administration ----

    @RequirePermissions(PERMISSIONS.USERS_READ)
    @Get()
    listUsers() {
        return this.usersService.listUsers();
    }

    @RequirePermissions(PERMISSIONS.USERS_READ)
    @Get(':id')
    getUserById(@Param('id') id: string) {
        return this.usersService.getUserById(id);
    }

    @RequirePermissions(PERMISSIONS.USERS_UPDATE)
    @Patch(':id')
    updateUser(@Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
        return this.usersService.updateUser(id, dto);
    }

    @RequirePermissions(PERMISSIONS.USERS_DEACTIVATE)
    @Patch(':id/deactivate')
    deactivateUser(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
        return this.usersService.deactivateUser(actor.userId, id);
    }

    @RequirePermissions(PERMISSIONS.USERS_MANAGE_ROLES)
    @Post(':id/roles')
    assignRole( 
        @CurrentUser() actor: { userId: string },
        @Param('id') id: string,
        @Body() dto: AssignRoleDto,
    ) {
        return this.usersService.assignRole(actor.userId, id, dto.roleId);
    }

    @RequirePermissions(PERMISSIONS.USERS_MANAGE_ROLES)
    @Delete(':id/roles/:roleId')
    removeRole(
        @CurrentUser() actor: { userId: string },
        @Param('id') id: string,
        @Param('roleId') roleId: string,
    ) {
        return this.usersService.removeRole(actor.userId, id, roleId);
    }

    @RequirePermissions(PERMISSIONS.USERS_EXPORT)
    @Get(':id/export')
    exportUser(@Param('id') id: string) {
        return this.usersService.exportUserData(id);
    }

    @RequirePermissions(PERMISSIONS.USERS_DELETE)
    @Delete(':id')
    deleteUser(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
        return this.usersService.hardDeleteUser(actor.userId, id);
    }

}