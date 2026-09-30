import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { PlatformRolesService } from './platform-roles.service';
import { CreatePlatformRoleDto } from './dto/create-platform-role.dto';
import { UpdatePlatformRoleDto } from './dto/update-platform-role.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Actor } from './platform-access.service';

/**
 * REST Controller for the custom, platform-scoped roles a platform owner/ADMIN creates to
 * delegate specific tasks (see `PlatformRolesService`'s doc comment).
 */
@ApiTags('Platform Roles')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/roles')
export class PlatformRolesController {

    constructor(private readonly platformRolesService: PlatformRolesService) {}

    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.platformRolesService.list(actor, platformId);
    }

    /** Permission catalog for the role editor, flagged with what the caller may grant. */
    @Get('catalog')
    catalog(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.platformRolesService.catalog(actor, platformId);
    }

    @Post()
    create(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Body() dto: CreatePlatformRoleDto) {
        return this.platformRolesService.create(actor, platformId, dto);
    }

    @Patch(':roleId')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('roleId') roleId: string,
        @Body() dto: UpdatePlatformRoleDto,
    ) {
        return this.platformRolesService.update(actor, platformId, roleId, dto);
    }

    @Delete(':roleId')
    remove(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('roleId') roleId: string) {
        return this.platformRolesService.remove(actor, platformId, roleId);
    }

}
