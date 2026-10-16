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
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MessagesService } from '../messages/messages.service';

/**
 * Type defining the requesting user (actor) details, including ID and global permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * REST Controller providing HTTP endpoints for managing platform lifecycle,
 * ownership transfers, and member access roles.
 */
@ApiTags('Platforms')
@ApiBearerAuth('access-token')
@Controller('platforms')
export class PlatformsController {
    constructor(
        private readonly platformsService: PlatformsService,
        private readonly messagesService: MessagesService,
    ) {}

    /**
     * Creates a new platform entity.
     * Requires global `PLATFORM_CREATE` permission.
     * * @route POST /platforms
     */
    @RequirePermissions(PERMISSIONS.PLATFORM_CREATE)
    @Post()
    create(@CurrentUser() actor: Actor, @Body() dto: CreatePlatformDto) {
        return this.platformsService.create(actor, dto);
    }

    /**
     * Lists platforms accessible to the current user.
     * Optionally filters to include archived platforms via query parameters.
     * * @route GET /platforms
     */
    @Get()
    list(@CurrentUser() actor: Actor, @Query('includeArchived') includeArchived?: string) {
        return this.platformsService.list(actor, includeArchived === 'true');
    }

    /**
     * Retrieves detailed information about a specific platform by ID.
     * * @route GET /platforms/:id
     */
    @Get(':id')
    getById(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.getById(actor, id);
    }

    /**
     * Updates platform properties (e.g., name, description, URL).
     * * @route PATCH /platforms/:id
     */
    @Patch(':id')
    update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdatePlatformDto) {
        return this.platformsService.update(actor, id, dto);
    }

    /**
     * Archives a platform (soft delete): stops its runtime if running and starts its 30-day
     * (configurable) permanent-deletion countdown. Reversible via `PATCH /:id/restore` at any
     * point before that window elapses.
     * * @route DELETE /platforms/:id
     */
    @Delete(':id')
    archive(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.archive(actor, id);
    }

    /**
     * Restores an archived platform back to active/draft status and cancels its pending
     * permanent-deletion countdown.
     * * @route PATCH /platforms/:id/restore
     */
    @Patch(':id/restore')
    restore(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.restore(actor, id);
    }

    /**
     * Immediately and irreversibly deletes an already-archived platform, without waiting for
     * its retention window to elapse: stops its runtime, deletes its generated files, and
     * hard-deletes its database row (and everything cascading from it). Requires the platform
     * to be ARCHIVED first (see `archive()`) - there is no way to permanently delete a platform
     * that hasn't at least passed through the reversible archived state.
     * * @route DELETE /platforms/:id/permanent
     */
    @Delete(':id/permanent')
    purge(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.purge(actor, id);
    }

    /**
     * Transfers platform primary ownership to another user.
     * * @route POST /platforms/:id/transfer-ownership
     */
    @Post(':id/transfer-ownership')
    transferOwnership(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: TransferOwnershipDto) {
        return this.platformsService.transferOwnership(actor, id, dto);
    }

    // ---- Member Management Endpoints ----

    /**
     * The caller's own effective access on a platform (owner / ADMIN / role name / permission keys).
     * Scoped to the caller by construction - it never reveals anyone else's access.
     * * @route GET /platforms/:id/my-access
     */
    @Get(':id/my-access')
    getMyAccess(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.getMyAccess(actor, id);
    }

    /**
     * Lists all assigned members for a given platform.
     * * @route GET /platforms/:id/members
     */
    @Get(':id/members')
    listMembers(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.platformsService.listMembers(actor, id);
    }

    /**
     * Adds a new member to a platform or upserts their access role.
     * * @route POST /platforms/:id/members
     */
    @Post(':id/members')
    addMember(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: AddMemberDto) {
        return this.platformsService.addMember(actor, id, dto);
    }

    /**
     * Updates an existing member's access role within a platform.
     * * @route PATCH /platforms/:id/members/:userId
     */
    @Patch(':id/members/:userId')
    updateMemberRole(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Param('userId') userId: string,
        @Body() dto: UpdateMemberRoleDto,
    ) {
        return this.platformsService.updateMemberRole(actor, id, userId, dto);
    }

    /**
     * Initiates member removal from a platform.
     * Might result in instant removal or trigger a pending removal request.
     * * @route DELETE /platforms/:id/members/:userId
     */
    @Delete(':id/members/:userId')
    removeMember(@CurrentUser() actor: Actor, @Param('id') id: string, @Param('userId') userId: string) {
        return this.platformsService.removeMember(actor, id, userId);
    }

    /**
     * Confirms and executes a pending member removal request.
     * * @route POST /platforms/:id/members/:userId/confirm-removal
     */
    @Post(':id/members/:userId/confirm-removal')
    confirmMemberRemoval(@CurrentUser() actor: Actor, @Param('id') id: string, @Param('userId') userId: string) {
        return this.platformsService.confirmMemberRemoval(actor, id, userId);
    }

    /**
     * Cancels an existing pending member removal request.
     * * @route POST /platforms/:id/members/:userId/cancel-removal
     */
    @Post(':id/members/:userId/cancel-removal')
    cancelMemberRemoval(@CurrentUser() actor: Actor, @Param('id') id: string, @Param('userId') userId: string) {
        return this.platformsService.cancelMemberRemoval(actor, id, userId);
    }

    @Get(':id/channel')
    getChannel(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.messagesService.getOrCreatePlatformChannel(actor, id);
    }
}
