import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Req,
    Res,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { avatarUploadOptions } from './avatar-upload.config';
import type { Request } from 'express';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse } from '@nestjs/swagger';

import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateProfileDetailsDto } from './dto/update-profile-details.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { AssignRoleDto } from './dto/assign-role.dto';
import { ChangeUserStatusDto } from './dto/change-status.dto';
import { ProcessDisabledUserDto } from './dto/process-disabled-user.dto';
import { DeleteOwnAccountDto } from './dto/delete-own-account.dto';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';

/**
 * Extracts request metadata (IP address and User-Agent) for security auditing - mirrors
 * `auth.controller.ts`'s identical helper, kept local here to avoid a cross-module import for
 * a two-line utility.
 */
function extractContext(req: Request) {
    return { ipAddress: req.ip, userAgent: req.headers['user-agent'] };
}

/**
 * Controller handling self-service user profile management, administrative user lifecycle operations,
 * role assignments, status transitions (suspend, reactivate, disable), and data retention compliance.
 */
@ApiTags('Users')
@ApiBearerAuth('access-token')
@Controller('users')
export class UsersController {
    constructor(private readonly usersService: UsersService) {}

    // ==========================================
    // 1. SELF SERVICE (Authenticated User Routes)
    // ==========================================

    /**
     * Retrieves identity profile details for the currently authenticated user.
     */
    @ApiOperation({ summary: 'Get current user identity profile' })
    @ApiOkResponse({ description: 'User profile retrieved successfully.' })
    @Get('me')
    getMe(@CurrentUser() user: { userId: string }) {
        return this.usersService.getMe(user.userId);
    }

    /**
     * Updates basic user profile identity attributes for the current user.
     */
    @ApiOperation({ summary: 'Update basic user credentials (e.g. personal email)' })
    @ApiOkResponse({ description: 'User credentials updated successfully.' })
    @Patch('me')
    updateMe(@CurrentUser() user: { userId: string }, @Body() dto: UpdateProfileDetailsDto) {
        return this.usersService.updateMe(user.userId, dto);
    }

    /**
     * Retrieves extended profile metadata for the current user.
     */
    @ApiOperation({ summary: 'Get extended profile details for current user' })
    @ApiOkResponse({ description: 'Extended profile details retrieved successfully.' })
    @Get('me/profile-details')
    getMyProfileDetails(@CurrentUser() user: { userId: string }) {
        return this.usersService.getMyProfileDetails(user.userId);
    }

    /**
     * Creates or updates extended profile metadata for the current user.
     */
    @ApiOperation({ summary: 'Upsert extended profile details for current user' })
    @ApiOkResponse({ description: 'Extended profile details updated successfully.' })
    @Patch('me/profile-details')
    updateMyProfileDetails(@CurrentUser() user: { userId: string }, @Body() dto: UpdateProfileDetailsDto) {
        return this.usersService.updateMyProfileDetails(user.userId, dto);
    }

    /**
     * Exports all stored personal data for the authenticated user in compliance with GDPR.
     */
    @ApiOperation({ summary: 'Export personal data for GDPR compliance' })
    @ApiOkResponse({ description: 'User personal data exported successfully.' })
    @Get('me/export')
    exportMe(@CurrentUser() user: { userId: string }) {
        return this.usersService.exportUserData(user.userId);
    }

    /**
     * Uploads (or replaces) the authenticated user's own profile photo. The client is expected
     * to have already cropped the image (see `AvatarCropModal` on the frontend) - this endpoint
     * accepts whatever square-ish image it receives and stores it as-is, it does not crop or
     * resize server-side.
     */
    @ApiOperation({ summary: "Upload the current user's avatar" })
    @ApiOkResponse({ description: 'Avatar uploaded and profile updated successfully.' })
    @Post('me/avatar')
    @UseInterceptors(FileInterceptor('file', avatarUploadOptions))
    async uploadMyAvatar(@CurrentUser() user: { userId: string }, @UploadedFile() file: Express.Multer.File) {
        if (!file) {
            throw new BadRequestException('No file was provided (expected multipart field "file").');
        }
        return this.usersService.saveAvatar(user.userId, file);
    }

    /**
     * Streams a user's avatar image. Any authenticated BackOS user may view any other user's
     * avatar - equivalent to a company directory photo, not sensitive data - so this route
     * intentionally carries no `@RequirePermissions`, only the global authentication guard.
     */
    @ApiOperation({ summary: "Get a user's avatar image" })
    @Get(':id/avatar')
    async getAvatar(@Param('id') id: string, @Res() res: Response) {
        await this.usersService.streamAvatar(id, res);
    }

    /**
     * Lists every platform the target user owns or is a member of, with their effective role -
     * shown on a user's detail page so an admin can see at a glance what they have access to.
     */
    @ApiOperation({ summary: 'List platforms a user owns or belongs to' })
    @ApiOkResponse({ description: "User's linked platforms retrieved successfully." })
    @RequirePermissions(PERMISSIONS.USERS_READ)
    @Get(':id/platforms')
    getUserPlatforms(@Param('id') id: string) {
        return this.usersService.getUserPlatforms(id);
    }

    /**
     * Permanently deletes the authenticated user's own account.
     *
     * SECURITY FIX (audit #3 - elevated): now requires a fresh TOTP "step-up" code in the
     * request body - see `UsersService.deleteOwnAccount()` / `AuthService.verifyStepUpTotp()`
     * for the full rationale. A bare, valid access token is no longer sufficient on its own to
     * trigger this irreversible action.
     */
    @ApiOperation({ summary: 'Delete own user account permanently (requires fresh TOTP code)' })
    @ApiOkResponse({ description: 'User account deleted successfully.' })
    @Delete('me')
    deleteMe(@CurrentUser() user: { userId: string }, @Body() dto: DeleteOwnAccountDto, @Req() req: Request) {
        return this.usersService.deleteOwnAccount(user.userId, dto.totpCode, extractContext(req));
    }

    // ==========================================
    // 2. ADMINISTRATIVE MANAGEMENT (RBAC Protected)
    // ==========================================

    /**
     * Retrieves a list of all system user accounts.
     */
    @ApiOperation({ summary: 'List all system users' })
    @ApiOkResponse({ description: 'List of system users retrieved successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_READ)
    @Get()
    listUsers() {
        return this.usersService.listUsers();
    }

    /**
     * Provisions and invites a new user account.
     */
    @ApiOperation({ summary: 'Provision a new user account' })
    @ApiOkResponse({ description: 'User account provisioned and invitation sent.' })
    @RequirePermissions(PERMISSIONS.USERS_CREATE)
    @Post()
    createUser(@CurrentUser() actor: { userId: string }, @Body() dto: CreateUserDto) {
        return this.usersService.createUser(dto, actor.userId);
    }

    /**
     * Resends the activation invitation email to a pending user account.
     */
    @ApiOperation({ summary: 'Resend activation email to a pending user' })
    @ApiOkResponse({ description: 'Activation email resent successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_CREATE)
    @Post(':id/resend-invitation')
    resendInvitation(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
        return this.usersService.resendInvitation(id, actor.userId);
    }

    /**
     * Retrieves detailed record of a specific target user by ID.
     */
    @ApiOperation({ summary: 'Get details of a specific user by ID' })
    @ApiOkResponse({ description: 'Target user details retrieved successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_READ)
    @Get(':id')
    getUserById(@Param('id') id: string) {
        return this.usersService.getUserById(id);
    }

    /**
     * Updates administrative attributes of a target user account.
     */
    @ApiOperation({ summary: 'Update administrative details of a target user' })
    @ApiOkResponse({ description: 'Target user administrative details updated successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_UPDATE)
    @Patch(':id')
    updateUser(@CurrentUser() actor: { userId: string }, @Param('id') id: string, @Body() dto: AdminUpdateUserDto) {
        return this.usersService.updateUser(actor.userId, id, dto);
    }

    /**
     * Suspends/Deactivates a target user account with reason tracking.
     */
    @ApiOperation({ summary: 'Suspend/Deactivate a user account' })
    @ApiOkResponse({ description: 'User account suspended and transition recorded.' })
    @RequirePermissions(PERMISSIONS.USERS_DEACTIVATE)
    @Patch(':id/deactivate')
    deactivateUser(
        @CurrentUser() actor: { userId: string },
        @Param('id') id: string,
        @Body() dto: ChangeUserStatusDto,
    ) {
        return this.usersService.deactivateUser(actor.userId, id, dto);
    }

    /**
     * Reactivates a suspended target user account.
     */
    @ApiOperation({ summary: 'Reactivate a suspended user account' })
    @ApiOkResponse({ description: 'User account reactivated successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_DEACTIVATE)
    @Patch(':id/activate')
    activateUser(@CurrentUser() actor: { userId: string }, @Param('id') id: string, @Body() dto: ChangeUserStatusDto) {
        return this.usersService.activateUser(actor.userId, id, dto);
    }

    /**
     * Transitions a suspended user to DISABLED status if the required retention grace period has elapsed.
     */
    @ApiOperation({ summary: 'Disable a suspended account after the grace period' })
    @ApiOkResponse({ description: 'User account successfully transitioned to DISABLED status.' })
    @RequirePermissions(PERMISSIONS.USERS_DEACTIVATE)
    @Patch(':id/disable')
    disableUser(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
        return this.usersService.disableUser(actor.userId, id);
    }

    /**
     * Processes a DISABLED user account by either anonymizing personal data or hard deleting the record.
     */
    @ApiOperation({ summary: 'Process a DISABLED user: Anonymize or Hard Delete' })
    @ApiOkResponse({ description: 'DISABLED user processed successfully (Anonymized or Hard Deleted).' })
    @RequirePermissions(PERMISSIONS.USERS_DELETE)
    @Post(':id/process-disabled')
    processDisabledUser(
        @CurrentUser() actor: { userId: string },
        @Param('id') id: string,
        @Body() dto: ProcessDisabledUserDto,
    ) {
        return this.usersService.processDisabledUser(actor.userId, id, dto);
    }

    /**
     * Retrieves status change history and suspension metrics for a target user.
     */
    @ApiOperation({ summary: 'Get status change history and deactivation audit metrics' })
    @ApiOkResponse({ description: 'User status history and audit metrics retrieved successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_READ)
    @Get(':id/status-audit')
    getUserStatusAudit(@Param('id') id: string) {
        return this.usersService.getUserStatusAudit(id);
    }

    /**
     * Assigns a role to a target user.
     */
    @ApiOperation({ summary: 'Assign a role to a target user' })
    @ApiOkResponse({ description: 'Role assigned to user successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_MANAGE_ROLES)
    @Post(':id/roles')
    assignRole(@CurrentUser() actor: { userId: string }, @Param('id') id: string, @Body() dto: AssignRoleDto) {
        return this.usersService.assignRole(actor.userId, id, dto.roleId);
    }

    /**
     * Revokes a role from a target user.
     */
    @ApiOperation({ summary: 'Revoke a role from a target user' })
    @ApiOkResponse({ description: 'Role revoked from user successfully.' })
    @RequirePermissions(PERMISSIONS.USERS_MANAGE_ROLES)
    @Delete(':id/roles/:roleId')
    removeRole(@CurrentUser() actor: { userId: string }, @Param('id') id: string, @Param('roleId') roleId: string) {
        return this.usersService.removeRole(actor.userId, id, roleId);
    }

    /**
     * Exports a target user's personal data (GDPR right of access). No blanket permission gate
     * anymore: access is decided in `UsersService.exportUserDataAs()` - the user themselves (via
     * `me/export`), a global USERS_EXPORT holder (the BackOS owner), or the owner / an ADMIN of
     * a platform the target user belongs to.
     */
    @ApiOperation({ summary: 'Export target user data for GDPR compliance' })
    @ApiOkResponse({ description: 'Target user personal data exported successfully.' })
    @Get(':id/export')
    exportUser(@CurrentUser() actor: { userId: string; permissions: string[] }, @Param('id') id: string) {
        return this.usersService.exportUserDataAs(actor, id);
    }

    /**
     * Permanently deletes a target user account from the database.
     */
    @ApiOperation({ summary: 'Permanently delete a user account' })
    @ApiOkResponse({ description: 'Target user account permanently deleted.' })
    @RequirePermissions(PERMISSIONS.USERS_DELETE)
    @Delete(':id')
    deleteUser(@CurrentUser() actor: { userId: string }, @Param('id') id: string) {
        return this.usersService.hardDeleteUser(actor.userId, id);
    }
}
