import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { PlatformAccessService } from '../platforms/platform-access.service';
import type { AuditContext } from '../audit/audit-log.service';
import { RoleHierarchyService } from '../common/services/role-hierarchy.service';
import { CreateUserDto } from './dto/create-user.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { UpdateProfileDetailsDto } from './dto/update-profile-details.dto';
import { PlanningScope, StatusChangeReason, UserStatus } from '@prismamodels/enums';
import { AuditLogService } from '../audit/audit-log.service';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { AUDIT_ACTIONS } from '../common/constants/audit-actions';
import { AUDIT_TARGETS } from '../common/constants/audit-target.constant';
import { ChangeUserStatusDto } from './dto/change-status.dto';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Response } from 'express';
import { resolveUploadDir } from '../files/multer.config';
import { matchesFileSignature, SIGNATURE_SAMPLE_BYTES } from '../files/file-signature.util';
import { avatarExtensionFor } from './avatar-upload.config';
import { ProcessDisabledUserDto, RetentionAction } from './dto/process-disabled-user.dto';

/**
 * Standard Prisma selection object to avoid leaking sensitive credentials or internal security details.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SAFE_USER_SELECT = {
    id: true,
    workEmail: true,
    personalEmail: true,
    username: true,
    firstName: true,
    lastName: true,
    /*
     * Fix Explanation:
     * 'company' and 'jobTitle' are fields of the UserProfile model.
     * We wrap them inside the 'profile' relation selection to match the Prisma schema.
     */
    profile: {
        select: {
            company: true,
            jobTitle: true,
        },
    },
    status: true,
    createdAt: true,
    updatedAt: true,
    userRoles: {
        select: { 
            role: { 
                select: { id: true, name: true } 
            } 
        },
    },
} as const;

/**
 * Core service managing user accounts, profiles, lifecycle transitions, role assignments, and GDPR compliance.
 */
@Injectable()
export class UsersService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly roleHierarchy: RoleHierarchyService,
        private readonly auditLog: AuditLogService,
        private readonly authService: AuthService,
        private readonly platformAccess: PlatformAccessService,
    ) {}

    // ---- Account Provisioning & Activation ----

    /**
     * Creates a new user account, generates a unique username, and dispatches an activation invitation.
     * * @param dto - Creation payload containing user identity and work email.
     * @returns The newly created raw User database entity.
     * @throws ConflictException if an account with the provided work email already exists.
     */
    async createUser(dto: CreateUserDto, actorId: string) {
        // 1. Check for duplicate work email
        const existing = await this.prisma.user.findUnique({ where: { workEmail: dto.workEmail } });
        if (existing) {
            throw new ConflictException('An account with this email address already exists.');
        }

        // 2. Fallback to auto-generated username if not explicitly provided
        const username = dto.username ?? (await this.generateUniqueUsername(dto.firstName, dto.lastName));

        // 3. Persist new user entity
        const user = await this.prisma.user.create({
            data: { 
                workEmail: dto.workEmail,
                personalEmail: dto.personalEmail,
                firstName: dto.firstName, 
                lastName: dto.lastName, 
                username,
            },
        });

        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_CREATE,
            actorId: actorId,
            targetType: AUDIT_TARGETS.USER,
            targetId: user.id,
        });

        // 4. Dispatch activation invitation email
        await this.authService.createInvitationForUser(user.id, actorId);
        
        return user;
    }

    /**
     * Resends an activation invitation email for an account pending setup.
     * * @param userId - ID of the target user.
     * @returns Success confirmation message payload.
     * @throws BadRequestException if the user is not in the pending invitation state.
     */
    async resendInvitation(userId: string, actorId: string) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

        if (user.status !== UserStatus.INVITED) {
            throw new BadRequestException('This account has already started or completed activation.');
        }

        await this.authService.createInvitationForUser(userId, actorId);

        return { message: 'Invitation email resent successfully.' };
    }

    // ---- Self Profile Management ----

    /**
     * Retrieves primary identity details for the authenticated user.
     * * @param userId - ID of the authenticated user.
     * @returns Safe user attributes.
     */
    async getMe(userId: string) {
        return this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: SAFE_USER_SELECT,
        });
    }

    /**
     * Updates basic profile details for the authenticated user.
     * * @param userId - ID of the authenticated user.
     * @param dto - Partial profile update payload.
     * @returns Updated safe user entity.
     */
    async updateMe(userId: string, dto: UpdateProfileDetailsDto) {
        // BUG FIX (API-001): the profile DTO (bio, phone, dateOfBirth...) used to be passed as-is to
        // `prisma.user.update`, whose model has none of these columns - any profile field made the
        // route fail with a 500. Profile fields go to UserProfile, personalEmail to User.
        await this.updateMyProfileDetails(userId, dto);
        return this.getMe(userId);
    }

    /**
     * Retrieves extended metadata for the authenticated user's profile (e.g., bio, birth date).
     * * @param userId - ID of the target user.
     * @returns Associated UserProfile record or null if unset.
     */
    async getMyProfileDetails(userId: string) {
        return this.prisma.userProfile.findUnique({ where: { userId } });
    }

    /**
     * Validates, stores and links a freshly uploaded avatar image.
     *
     * Storage convention: `avatars/<userId>.<ext>` - a fixed name per user rather than a random
     * one, so replacing an avatar never leaves the previous file orphaned on disk (any leftover
     * file with a DIFFERENT extension from a prior upload is removed explicitly, since switching
     * from e.g. `.png` to `.jpg` would otherwise leave the old `.png` behind under a new name).
     *
     * @throws BadRequestException when the declared MIME type's magic bytes don't match (the
     * `Content-Type` a multipart field carries is client-controlled and trivially spoofed).
     */
    async saveAvatar(userId: string, file: Express.Multer.File) {
        const extension = avatarExtensionFor(file.mimetype);
        if (!extension || !matchesFileSignature(file.mimetype, file.buffer.subarray(0, SIGNATURE_SAMPLE_BYTES))) {
            throw new BadRequestException('This file does not look like a valid PNG, JPEG or WEBP image.');
        }

        const dir = path.join(resolveUploadDir(), 'avatars');
        await fs.mkdir(dir, { recursive: true });

        // Clean up a previous avatar stored under a different extension for this user.
        for (const otherExtension of ['png', 'jpg', 'webp']) {
            if (otherExtension === extension) continue;
            await fs.unlink(path.join(dir, `${userId}.${otherExtension}`)).catch(() => undefined);
        }

        await fs.writeFile(path.join(dir, `${userId}.${extension}`), file.buffer);

        const avatarUrl = `/users/${userId}/avatar`;
        await this.prisma.userProfile.upsert({
            where: { userId },
            update: { avatarUrl },
            create: { userId, avatarUrl },
        });

        return { avatarUrl };
    }

    /**
     * Streams a user's stored avatar file, whatever its extension turns out to be. `no-store`
     * because the URL is stable across re-uploads (`avatars/<userId>.<ext>`) - without it, a
     * browser could keep showing a stale image after someone changes their photo.
     *
     * @throws NotFoundException when the user has never uploaded an avatar.
     */
    async streamAvatar(userId: string, res: Response): Promise<void> {
        // SECURITY FIX (SEC-011): the id comes from the URL and was joined into a filesystem path,
        // so `..%2F..%2F<path>` could read any .png/.jpg/.webp file on the host.
        if (!UUID_PATTERN.test(userId)) {
            throw new NotFoundException('This user has no avatar.');
        }
        const dir = path.join(resolveUploadDir(), 'avatars');
        for (const [extension, mimeType] of [['png', 'image/png'], ['jpg', 'image/jpeg'], ['webp', 'image/webp']] as const) {
            const diskPath = path.join(dir, `${userId}.${extension}`);
            if (
                await fs
                    .access(diskPath)
                    .then(() => true)
                    .catch(() => false)
            ) {
                res.setHeader('Content-Type', mimeType);
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('X-Content-Type-Options', 'nosniff');
                res.sendFile(diskPath);
                return;
            }
        }
        throw new NotFoundException('This user has no avatar.');
    }

    /**
     * Every platform the target user owns or belongs to, with their effective role on each -
     * used by the user detail page ("what does this person have access to?").
     */
    async getUserPlatforms(userId: string) {
        const [owned, memberships] = await Promise.all([
            this.prisma.platform.findMany({
                where: { ownerId: userId },
                select: { id: true, name: true, slug: true, status: true },
                orderBy: { name: 'asc' },
            }),
            this.prisma.platformMember.findMany({
                where: { userId },
                select: {
                    platformRole: { select: { name: true, isSystem: true } },
                    platform: { select: { id: true, name: true, slug: true, status: true } },
                },
                orderBy: { createdAt: 'asc' },
            }),
        ]);

        return [
            ...owned.map((platform) => ({ platform, role: 'OWNER' as const })),
            // `role` is the platform role's display name ("ADMIN" for the system role, or the custom
            // role's own name, e.g. "Data Operator"); `isSystemRole` lets the UI tell them apart.
            ...memberships.map((m) => ({ platform: m.platform, role: m.platformRole.name, isSystemRole: m.platformRole.isSystem })),
        ];
    }

    /**
     * Upserts extended metadata for the authenticated user's profile.
     * * @param userId - ID of the authenticated user.
     * @param dto - Extended profile details payload.
     * @returns Updated or created UserProfile entity.
     */
    async updateMyProfileDetails(userId: string, dto: UpdateProfileDetailsDto) {
        // Separate personalEmail (belongs to User) from the rest of the metadata (belongs to UserProfile)
        const { personalEmail, dateOfBirth, ...profileData } = dto;

        const parsedDate = dateOfBirth ? new Date(dateOfBirth) : undefined;

        // 1. If personalEmail is present, update the primary User entity
        if (personalEmail !== undefined) {
            await this.prisma.user.update({
                where: { id: userId },
                data: { personalEmail },
            });
        }

        // 2. Upsert the extended details in UserProfile entity
        return this.prisma.userProfile.upsert({
            where: { userId },
            update: { ...profileData, dateOfBirth: parsedDate },
            create: { userId, ...profileData, dateOfBirth: parsedDate },
        });
    }

    // ---- Administrative User Management & Lifecycle ----

    /**
     * Lists all registered users in the system.
     * * @returns Array of safe user entities ordered by registration date.
     */
    async listUsers() {
        return this.prisma.user.findMany({
            select: SAFE_USER_SELECT,
            orderBy: { createdAt: 'asc' },
        });
    }

    /**
     * Fetches a specific user entity by ID.
     * * @param id - Target user ID.
     * @returns Safe user entity attributes.
     * @throws NotFoundException if the user does not exist.
     */
    async getUserById(id: string) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            select: SAFE_USER_SELECT,
        });

        if (!user) {
            throw new NotFoundException('User not found.');
        }

        return user;
    }

    /**
     * Updates administrative attributes of a target user account while enforcing 
     * hierarchy permissions, uniqueness constraints, and audit logging.
     *
     * @param actorUserId - ID of the administrator issuing the update.
     * @param targetUserId - ID of the target user to update.
     * @param dto - Admin update payload containing modified attributes.
     * @returns Updated safe user entity.
     * @throws NotFoundException if target user does not exist.
     * @throws ConflictException if updated workEmail or username is already taken.
     * @throws ForbiddenException if actor lacks hierarchy seniority over target or target is protected.
     */
    async updateUser(
        actorUserId: string,
        targetUserId: string,
        dto: AdminUpdateUserDto,
    ) {
        // 1. Security checks: Hierarchy seniority and protected owner verification
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, targetUserId, 'update');
        await this.assertNotProtectedOwner(targetUserId, 'update');

        // 2. Ensure target user exists
        const existingUser = await this.getUserById(targetUserId);

        // 3. Check unique constraint collisions for work email
        if (dto.workEmail && dto.workEmail !== existingUser.workEmail) {
            const emailConflict = await this.prisma.user.findFirst({
                where: { workEmail: dto.workEmail, NOT: { id: targetUserId } },
            });
            if (emailConflict) {
                throw new ConflictException('Work email is already in use by another user.');
            }
        }

        // 4. Check unique constraint collisions for username
        if (dto.username && dto.username !== existingUser.username) {
            const usernameConflict = await this.prisma.user.findFirst({
                where: { username: dto.username, NOT: { id: targetUserId } },
            });
            if (usernameConflict) {
                throw new ConflictException('Username is already taken by another user.');
            }
        }

        // 5. Update user attributes
        const updatedUser = await this.prisma.user.update({
            where: { id: targetUserId },
            data: {
                workEmail: dto.workEmail,
                firstName: dto.firstName,
                lastName: dto.lastName,
                username: dto.username,
                /*
                * Fix Explanation:
                * 'company' and 'jobTitle' belong to the UserProfile model.
                * We use Prisma's nested update/upsert on the 'profile' relation 
                * to update existing profile attributes or create the relation if missing.
                */
                ...(dto.company !== undefined || dto.jobTitle !== undefined
                    ? {
                        profile: {
                            upsert: {
                                create: {
                                    company: dto.company,
                                    jobTitle: dto.jobTitle,
                                },
                                update: {
                                    company: dto.company,
                                    jobTitle: dto.jobTitle,
                                },
                            },
                        },
                    }
                    : {}),
            },
            select: SAFE_USER_SELECT,
        });

        // 6. Log administrative update action in audit log
        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_UPDATE,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: targetUserId,
            metadata: {
                updatedFields: Object.keys(dto),
            },
        });

        return updatedUser;
    }

    /**
     * Deactivates a user account while enforcing role hierarchy and owner protections.
     * * @param actorUserId - ID of the administrator issuing the request.
     * @param id - Target user ID to deactivate.
     * @returns Deactivated safe user entity.
     * @throws ForbiddenException if actor is not senior or target is the sole system owner.
     */
    async deactivateUser(
        actorUserId: string,
        targetUserId: string,
        dto: ChangeUserStatusDto,
    ) {
        // 1. Security checks
        this.assertNotSelf(actorUserId, targetUserId, 'deactivate');
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, targetUserId, 'deactivate');
        await this.assertNotProtectedOwner(targetUserId,'deactivate');

        // 2. Update user and create status history atomically
        const updatedUser = await this.prisma.$transaction(async (tx) => {
            // Retrieve the current user state
            const targetUser = await tx.user.findUnique({
                where: {
                    id: targetUserId,
                },
            });

            if (!targetUser) {
                throw new NotFoundException('User not found.');
            }

            // Prevent redundant status transition
            if (targetUser.status === UserStatus.SUSPENDED) {
                throw new BadRequestException(
                    'User account is already suspended.',
                );
            }

            // Update user status
            const user = await tx.user.update({
                where: {
                    id: targetUserId,
                },
                data: {
                    status: UserStatus.SUSPENDED,
                    suspendedAt: new Date(),
                },
                select: SAFE_USER_SELECT,
            });

            // Record lifecycle transition
            await tx.userStatusHistory.create({
                data: {
                    userId: targetUserId,
                    previousStatus: targetUser.status,
                    newStatus: UserStatus.SUSPENDED,
                    reason: dto.reason,
                    comment: dto.comment,
                    performedById: actorUserId,
                },
            });

            return user;
        });

        // 3. Record successful administrative action
        // SECURITY FIX (SEC-002): suspension now ends every session immediately.
        await this.authService.revokeAllRefreshTokens(targetUserId);

        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_DEACTIVATE,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: targetUserId,
        });

        // 4. Return updated user
        return updatedUser;
    }

    /**
     * Retrieves audit metrics and history for a specific user account.
     */
    async getUserStatusAudit(userId: string) {
        await this.getUserById(userId);

        const history = await this.prisma.userStatusHistory.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });

        const deactivationEvents = history.filter((h) => h.newStatus === UserStatus.SUSPENDED);
        const deactivationCount = deactivationEvents.length;

        let totalDeactivatedDurationMs = 0;
        
        for (let i = 0; i < history.length; i++) {
            const entry = history[i];
            if (entry.newStatus === UserStatus.SUSPENDED) {
                const reactivationEntry = history.slice(0, i).reverse().find(
                    (h) => h.createdAt > entry.createdAt && (h.newStatus === UserStatus.ACTIVE || h.newStatus === UserStatus.DISABLED)
                );
                const endTime = reactivationEntry ? reactivationEntry.createdAt : new Date();
                totalDeactivatedDurationMs += (endTime.getTime() - entry.createdAt.getTime());
            }
        }
        const totalDeactivatedDays = Math.round(totalDeactivatedDurationMs / (1000 * 3600 * 24));
        return {
            userId,
            deactivationCount,
            totalDeactivatedDays,
            history,
        };
    }

    /**
     * Reactivates a suspended user account while enforcing role hierarchy checks, 
     * resetting deactivation timestamps, and recording history and audit logs.
     *
     * @param actorUserId - ID of the administrator issuing the request.
     * @param targetUserId - Target user ID to reactivate.
     * @param dto - Payload containing the reason and optional comments for reactivation.
     * @returns Reactivated safe user entity.
     * @throws NotFoundException if the target user does not exist.
     * @throws BadRequestException if the user account is not currently in SUSPENDED status.
     * @throws ForbiddenException if actor lacks hierarchy seniority over target.
     */
    async activateUser(
        actorUserId: string,
        targetUserId: string,
        dto: ChangeUserStatusDto,
    ) {
        // 1. Security check: Ensure the actor has higher hierarchy seniority than the target user
        // SECURITY FIX (SEC-002): `assertSeniorToTarget` returns early when actor = target, which let a
        // suspended user holding users.deactivate reactivate their own account.
        this.assertNotSelf(actorUserId, targetUserId, 'reactivate');
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, targetUserId, 'reactivate');

        // 2. Update user, reset timestamp, and create status history entry atomically
        const updatedUser = await this.prisma.$transaction(async (tx) => {
            // Retrieve current user state within transaction
            const targetUser = await tx.user.findUnique({
                where: {
                    id: targetUserId,
                },
            });

            if (!targetUser) {
                throw new NotFoundException('User not found.');
            }

            // Only accounts in SUSPENDED status are eligible for reactivation
            if (targetUser.status !== UserStatus.SUSPENDED) {
                throw new BadRequestException(
                    'Only suspended accounts can be reactivated.',
                );
            }

            // Update user status and reset deactivation timestamp
            const user = await tx.user.update({
                where: {
                    id: targetUserId,
                },
                data: {
                    status: UserStatus.ACTIVE,
                    suspendedAt: null, // Clear deactivation timestamp upon reactivation
                },
                select: SAFE_USER_SELECT,
            });

            // Record lifecycle transition in history table
            await tx.userStatusHistory.create({
                data: {
                    userId: targetUserId,
                    previousStatus: targetUser.status,
                    newStatus: UserStatus.ACTIVE,
                    reason: dto.reason,
                    comment: dto.comment,
                    performedById: actorUserId,
                },
            });

            return user;
        });

        // 3. Record successful administrative action in global audit log
        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_REACTIVATE,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: targetUserId,
        });

        // 4. Return updated user
        return updatedUser;
    }

    /**
     * Transitions a suspended user to DISABLED status if the mandatory deactivation grace period has elapsed.
     * Enforces hierarchy checks, owner protections, records history in transaction, and logs audit entries.
     *
     * @param actorUserId - ID of the administrator issuing the request.
     * @param targetUserId - Target user ID to disable.
     * @returns Disabled safe user entity.
     * @throws NotFoundException if target user is not found.
     * @throws BadRequestException if user is not SUSPENDED or if grace period has not elapsed.
     * @throws ForbiddenException if actor lacks hierarchy seniority over target or target is protected owner.
     */
    async disableUser(actorUserId: string, targetUserId: string) {
        // 1. Security checks
        this.assertNotSelf(actorUserId, targetUserId, 'disable');
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, targetUserId, 'disable');
        await this.assertNotProtectedOwner(targetUserId, 'disable');

        // 2. Fetch grace period configuration (defaults to 60 days)
        const DEACTIVATION_GRACE_PERIOD_DAYS = this.configService.get<number>(
            // CONFIG FIX (ARCH-003): the 'status' namespace was never loaded; read the env var directly.
            'DEACTIVATION_GRACE_PERIOD_DAYS',
            60,
        );

        // 3. Atomically validate status, check elapsed time, update status, and record history
        const updatedUser = await this.prisma.$transaction(async (tx) => {
            const targetUser = await tx.user.findUnique({ where: { id: targetUserId } });

            if (!targetUser) {
                throw new NotFoundException('User not found.');
            }

            if (targetUser.status !== UserStatus.SUSPENDED || !targetUser.suspendedAt) {
                throw new BadRequestException('Account must be in SUSPENDED status before it can be disabled.');
            }

            // Verify elapsed retention period
            const now = new Date();
            const daysDeactivated = (now.getTime() - targetUser.suspendedAt.getTime()) / (1000 * 3600 * 24);

            if (daysDeactivated < DEACTIVATION_GRACE_PERIOD_DAYS) {
                const remainingDays = Math.ceil(DEACTIVATION_GRACE_PERIOD_DAYS - daysDeactivated);
                throw new BadRequestException(
                    `Account must remain deactivated for ${DEACTIVATION_GRACE_PERIOD_DAYS} days before disabling. ${remainingDays} day(s) remaining.`,
                );
            }

            // Update user status
            const user = await tx.user.update({
                where: { id: targetUserId },
                data: { status: UserStatus.DISABLED },
                select: SAFE_USER_SELECT,
            });

            // Record history transition
            await tx.userStatusHistory.create({
                data: {
                    userId: targetUserId,
                    previousStatus: targetUser.status,
                    newStatus: UserStatus.DISABLED,
                    reason: StatusChangeReason.PERIODIC_CLEANUP,
                    comment: 'Grace period elapsed. Account transitioned to DISABLED.',
                    performedById: actorUserId,
                },
            });

            return user;
        });

        // 4. Log audit action AFTER successful transaction
        await this.authService.revokeAllRefreshTokens(targetUserId);

        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_DISABLE,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: targetUserId,
        });

        return updatedUser;
    }

    /**
     * Processes a DISABLED user account by either anonymizing personal data (GDPR compliant)
     * or hard-deleting the record from the database.
     *
     * @param actorUserId - ID of the administrator issuing the request.
     * @param targetUserId - Target user ID to process.
     * @param dto - Processing payload specifying the retention action (DELETE or ANONYMIZE).
     * @returns Success payload or hard deletion outcome.
     * @throws NotFoundException if target user is not found.
     * @throws BadRequestException if account is not in DISABLED status.
     * @throws ForbiddenException if actor lacks hierarchy seniority over target or target is protected owner.
     */
    async processDisabledUser(
        actorUserId: string,
        targetUserId: string,
        dto: ProcessDisabledUserDto,
    ) {
        // 1. Security checks
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, targetUserId, 'process data for');
        await this.assertNotProtectedOwner(targetUserId, 'process data for');

        // 2. Validate current state
        const targetUser = await this.prisma.user.findUnique({ where: { id: targetUserId } });
        if (!targetUser) {
            throw new NotFoundException('User not found.');
        }

        if (targetUser.status !== UserStatus.DISABLED) {
            throw new BadRequestException(
                'Only accounts with DISABLED status can be processed for deletion or anonymization.',
            );
        }

        // 3. Option 1: Hard Delete
        if (dto.action === RetentionAction.DELETE) {
            return this.hardDeleteUser(actorUserId, targetUserId);
        }

        // 4. Option 2: GDPR Anonymization
        if (dto.action === RetentionAction.ANONYMIZE) {
            const anonymousTag = `deleted-user-${targetUserId.replace(/-/g, "").slice(0, 16)}`;

            await this.prisma.$transaction(async (tx) => {
                // PRIVACY/SECURITY FIX: an anonymized account keeps no credential of any kind.
                await tx.refreshToken.updateMany({ where: { userId: targetUserId, revokedAt: null }, data: { revokedAt: new Date() } });
                await tx.userMfa.deleteMany({ where: { userId: targetUserId } });
                await tx.recoveryCode.deleteMany({ where: { userId: targetUserId } });
                await tx.invitation.deleteMany({ where: { userId: targetUserId } });
                // Delete linked metadata profile
                await tx.userProfile.deleteMany({ where: { userId: targetUserId } });

                // Overwrite personal data with anonymized defaults
                await tx.user.update({
                    where: { id: targetUserId },
                    data: {
                        firstName: 'Former',
                        lastName: 'Employee',
                        username: anonymousTag,
                        workEmail: `${anonymousTag}@anonymized.local`,
                        personalEmail: null,
                    },
                });
            });

            // Log administrative data processing audit event
            await this.deleteAvatarFiles(targetUserId);

            await this.auditLog.log({
                action: AUDIT_ACTIONS.USERS_ANONYMIZE,
                actorId: actorUserId,
                targetType: AUDIT_TARGETS.USER,
                targetId: targetUserId,
            });

            return { message: 'User data anonymized successfully.' };
        }
    }

    // ---- Role Management ----

    /**
     * Grants a specific role to a user.
     * * @param actorUserId - ID of the actor assigning the role.
     * @param userId - Target user ID receiving the role.
     * @param roleId - Target role ID.
     * @returns UserRole mapping entity.
     */
    async assignRole(actorUserId: string, userId: string, roleId: string) {
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, userId, 'manage roles for');
        await this.roleHierarchy.assertCanGrantRole(actorUserId, roleId);

        await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        await this.prisma.role.findUniqueOrThrow({ where: { id: roleId } });

        const assignedRole = await this.prisma.userRole.upsert({
            where: { userId_roleId: { userId, roleId } },
            update: {},
            create: { userId, roleId },
        });

        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_MANAGE_ROLES,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: userId,
            metadata: {
                roleId,
            },
        });

        return assignedRole;
    }

    /**
     * Revokes a role assignment from a user, ensuring the sole system owner role remains protected.
     * * @param actorUserId - ID of the actor revoking the role.
     * @param userId - Target user losing the role assignment.
     * @param roleId - Role ID to revoke.
     * @throws ForbiddenException if attempting to revoke the owner role from the last system owner.
     */
    async removeRole(actorUserId: string, userId: string, roleId: string) {
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, userId, 'manage roles for');

        const role = await this.prisma.role.findUnique({ where: { id: roleId } });

        // Guardrail: Ensure system is not left without an owner
        if (role?.name === 'owner') {
            const ownerCount = await this.prisma.userRole.count({
                where: { roleId },
            });

            if (ownerCount <= 1) {
                throw new ForbiddenException(
                    'Cannot remove the last owner from the system.',
                );
            }
        }

        const result = await this.prisma.userRole.deleteMany({
            where: { userId, roleId },
        });

        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_MANAGE_ROLES,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: userId,
            metadata: {
                roleId,
                operation: 'remove',
            },
        });

        return result;
    }

    // ---- GDPR & Permanent Deletion ----

    /**
     * Access rule for exporting SOMEONE ELSE's personal data (GDPR right of access). Allowed:
     * - the user themselves (their own data);
     * - a holder of the global USERS_EXPORT permission (the BackOS owner);
     * - the owner or an ADMIN of a platform the target user belongs to (as a member, or as its
     *   owner) - never a plain member, and never a custom role.
     * Anyone else gets a 403, so a random authenticated user (or an ADMIN of an unrelated
     * platform) can never pull another person's data.
     */
    async exportUserDataAs(actor: { userId: string; permissions: string[] }, targetUserId: string) {
        // PRIVACY FIX (SEC-012): being owner/ADMIN of a platform the target belongs to no longer
        // grants access to their GDPR export. Membership can be granted without the target's
        // consent, and the export covers data from every other tenant (owned platforms,
        // generations, personal e-mail) - it is now self-service or `users.export` only.
        if (actor.userId !== targetUserId && !actor.permissions.includes(PERMISSIONS.USERS_EXPORT)) {
            throw new ForbiddenException("You are not allowed to export this user's data.");
        }
        return this.exportUserData(targetUserId);
    }

    /**
     * Exports all user records for GDPR compliance and data portability.
     * * @param userId - ID of the user requesting export.
     * @returns Aggregated entity dataset for the user.
     * @throws NotFoundException if the user does not exist.
     */
    async exportUserData(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                workEmail: true,
                personalEmail: true,
                firstName: true,
                lastName: true,
                username: true,
                /*
                * Fix Explanation:
                * 'company' and 'jobTitle' belong to the UserProfile model ('profile' relation).
                * Nested select is required here to query those fields from the related table.
                */
                profile: {
                    select: {
                        company: true,
                        jobTitle: true,
                    },
                },
                status: true,
                createdAt: true,
                updatedAt: true,
                userRoles: { select: { role: { select: { name: true } } } },
                platformOwned: {
                    select: { id: true, name: true, slug: true, status: true, createdAt: true },
                },
                generations: {
                    select: {
                        id: true,
                        platformId: true,
                        status: true,
                        startedAt: true,
                        finishedAt: true,
                    },
                },
            },
        });

        if (!user) {
            throw new NotFoundException('User not found.');
        }

        return user;
    }

    /**
     * Permanently deletes a user account from the database.
     * * @param actorUserId - ID of the actor initiating deletion.
     * @param userId - Target user ID to permanently erase.
     * @returns Confirmation payload upon successful deletion.
     * @throws ConflictException if the target user still owns active platforms, is still the
     *   responsible party of a Planning, or has created PlanningEntry records.
     * @throws ForbiddenException if attempting to hard delete the last owner.
     */
    async hardDeleteUser(actorUserId: string, userId: string) {
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, userId, 'delete');

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { platformOwned: { select: { id: true } } },
        });

        if (!user) {
            throw new NotFoundException('User not found.');
        }

        if (user.platformOwned.length > 0) {
            throw new ConflictException(
                'Please transfer ownership of your platforms before deleting this account.',
            );
        }

        // SECURITY FIX (audit #1 follow-up - critical): `Planning.responsible` is now
        // `onDelete: SetNull` (see `schema.prisma`), so this is no longer a data-destruction
        // risk - but silently orphaning a team's planning (no one responsible for it) on
        // account deletion is still a bad outcome worth preventing up front. Mirrors the
        // `platformOwned` check above; resolved via `PlanningService.reassignResponsible()`
        // (`PATCH /platforms/:platformId/planning/responsible`).
        const responsibleForCount = await this.prisma.planning.count({
            where: { responsibleId: userId, scope: { not: PlanningScope.PERSONAL } },
        });
        if (responsibleForCount > 0) {
            throw new ConflictException(
                'Please reassign responsibility for your team planning(s) before deleting this account.',
            );
        }

        // SECURITY FIX (audit #5 - elevated): `PlanningEntry.creatorId` is required with no
        // explicit `onDelete` (defaults to `Restrict`), so deletion used to fail deep inside
        // Prisma with an opaque, generic 409 from `AllExceptionsFilter` - the caller had no way
        // to know *why*. This replicates the same explicit, actionable pre-check already used
        // for `platformOwned` above, for the exact same class of problem.
        const createdEntriesCount = await this.prisma.planningEntry.count({
            where: { creatorId: userId, planning: { scope: { not: PlanningScope.PERSONAL } } },
        });
        if (createdEntriesCount > 0) {
            throw new ConflictException(
                'This account has created planning items (tasks/events) that must be reassigned or removed before it can be deleted.',
            );
        }

        await this.assertNotProtectedOwner(userId, 'delete');

        await this.auditLog.log({
            action: AUDIT_ACTIONS.USERS_DELETE,
            actorId: actorUserId,
            targetType: AUDIT_TARGETS.USER,
            targetId: userId,
        });

        // DB-008: FileAsset rows cascade with the user, but the files themselves used to stay on
        // disk forever (personal data included). They are removed first.
        const ownedFiles = await this.prisma.fileAsset.findMany({ where: { uploaderId: userId }, select: { storedName: true } });

        await this.prisma.$transaction([
            this.prisma.planning.deleteMany({
                where: { scope: PlanningScope.PERSONAL, responsibleId: userId, platformId: null },
            }),
            this.prisma.user.delete({ where: { id: userId } }),
        ]);

        for (const file of ownedFiles) {
            await fs.unlink(path.join(resolveUploadDir(), path.basename(file.storedName))).catch(() => undefined);
        }
        await this.deleteAvatarFiles(userId);

        return { message: 'Account permanently deleted.' };
    }

    /**
     * SECURITY FIX (audit #3 - elevated): self-service account deletion entry point, now
     * requiring a fresh "step-up" TOTP code before the irreversible `hardDeleteUser()` call.
     *
     * Previously `DELETE /users/me` called `hardDeleteUser()` directly off the strength of the
     * caller's access token alone. Since this system is passwordless (identifier + TOTP only),
     * that token is the ONLY thing standing between an attacker and permanently destroying the
     * victim's account for up to 15 minutes after it was issued - e.g. if intercepted via XSS,
     * a compromised device, or a proxy log. Requiring a fresh TOTP code here (delegated to
     * `AuthService.verifyStepUpTotp()`) closes that window without introducing a password.
     *
     * @param userId - The authenticated user requesting to delete their own account.
     * @param totpCode - Fresh 6-digit TOTP code proving current possession of the MFA device.
     * @param context - Audit metadata (IP address, user agent) for the security audit trail.
     * @throws UnauthorizedException if the supplied TOTP code is invalid (via
     *   `AuthService.verifyStepUpTotp()`).
     * @throws ConflictException / ForbiddenException - see `hardDeleteUser()`.
     */
    async deleteOwnAccount(userId: string, totpCode: string, context: AuditContext) {
        await this.authService.verifyStepUpTotp(userId, totpCode, context);
        return this.hardDeleteUser(userId, userId);
    }

    // ---- Private Helpers ----

    /**
     * Generates a unique normalized username string.
     * * Converts input names to lowercase, strips diacritical marks, and increments a trailing counter on collision.
     * * Example: `Jane Doe` -> `jane.doe` -> `jane.doe2` (if duplicate exists).
     * * @param firstName - User's first name.
     * @param lastName - User's last name.
     * @returns A unique candidate username.
     */
    private async generateUniqueUsername(firstName: string, lastName: string): Promise<string> {
        const base = `${firstName}.${lastName}`
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9.]+/g, '');

        let candidate = base;
        let counter = 2;

        while (await this.prisma.user.findUnique({ where: { username: candidate } })) {
            candidate = `${base}${counter}`;
            counter++;
        }

        return candidate;
    }

    /**
     * Safety guardrail ensuring destructive actions cannot target the system's sole owner.
     * * @param userId - Target user ID.
     * @param action - Action name for dynamic exception messaging.
     * @throws ForbiddenException if target user is the sole system owner.
     */
    /** SEC-002: an account's status can never be changed by the account itself. */
    private assertNotSelf(actorUserId: string, targetUserId: string, action: string): void {
        if (actorUserId === targetUserId) {
            throw new ForbiddenException(`You cannot ${action} your own account.`);
        }
    }

    private async deleteAvatarFiles(userId: string): Promise<void> {
        if (!UUID_PATTERN.test(userId)) return;
        const dir = path.join(resolveUploadDir(), 'avatars');
        for (const extension of ['png', 'jpg', 'webp']) {
            await fs.unlink(path.join(dir, `${userId}.${extension}`)).catch(() => undefined);
        }
    }

    private async assertNotProtectedOwner(userId: string, action: string) {
        const userRoles = await this.prisma.userRole.findMany({
            where: { userId },
            include: { role: true },
        });

        const isOwner = userRoles.some((ur) => ur.role.name === 'owner');
        if (!isOwner) return;

        const ownerCount = await this.prisma.userRole.count({
            where: { role: { name: 'owner' } },
        });

        if (ownerCount <= 1) {
            throw new ForbiddenException(
                `Cannot ${action} the last owner in the system.`,
            );
        }
    }
}