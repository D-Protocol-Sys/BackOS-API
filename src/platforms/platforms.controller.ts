import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PlatformsService } from './platforms.service';
import { CreatePlatformDto } from './dto/create-platform.dto';
import { UpdatePlatformDto } from './dto/update-platform.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';

type Actor = { userId: string; permissions: string[] };

@Controller('platforms')
export class PlatformsController {

    constructor(private readonly platformsService: PlatformsService) {}

    @RequirePermissions(PERMISSIONS.PLATFORM_CREATE)
    @Post()
    create(@CurrentUser() actor: Actor, @Body() dto: CreatePlatformDto) {
        return this.platformsService.create(actor, dto);
    }

    @Get()
    list(@CurrentUser() actor: Actor, @Query('includeArchived') includeArchived?: string) {
        return this.platformsService.list(actor, includeArchived === 'true');
    }

    @Get(':id')
    getById(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.getById(actor, id);
    }

    @Patch(':id')
    update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdatePlatformDto) {
        return this.platformsService.update(actor, id, dto);
    }

    @Delete(':id')
    archive(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.archive(actor, id);
    }

    @Patch(':id/restore')
    restore(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.restore(actor, id);
    }

    @Post(':id/transfer-ownership')
    transferOwnership(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Body() dto: TransferOwnershipDto,
    ) {
        return this.platformsService.transferOwnership(actor, id, dto);
    }

    @Get(':id/members')
    listMembers(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.listMembers(actor, id);
    }

    @Post(':id/members')
    addMember(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: AddMemberDto) {
        return this.platformsService.addMember(actor, id, dto);
    }

    @Patch(':id/members/:userId')
    updateMemberRole(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Param('userId') userId: string,
        @Body() dto: UpdateMemberRoleDto,
    ) {
        return this.platformsService.updateMemberRole(actor, id, userId, dto);
    }

    @Delete(':id/members/:userId')
    removeMember(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Param('userId') userId: string,
    ) {
        return this.platformsService.removeMember(actor, id, userId);
    }

    @Post(':id/members/:userId/confirm-removal')
    confirmMemberRemoval(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Param('userId') userId: string,
    ) {
        return this.platformsService.confirmMemberRemoval(actor, id, userId);
    }

    @Post(':id/members/:userId/cancel-removal')
    cancelMemberRemoval(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Param('userId') userId: string,
    ) {
        return this.platformsService.cancelMemberRemoval(actor, id, userId);
    }

}
