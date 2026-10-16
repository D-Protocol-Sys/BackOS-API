import {
    Injectable,
    Logger,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import * as fs from 'fs/promises';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlatformDto } from './dto/create-platform.dto';
import { UpdatePlatformDto } from './dto/update-platform.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { slugify } from '../common/utils/slugify.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { PLATFORM_PERMISSIONS } from '../common/constants/platform-permissions.constant';
import { UserStatus } from '@prismamodels/client';
import { DockerRuntimeManagerService } from '../generator/docker-runtime-manager.service';
import { ProjectScaffolderService } from '../generator/project-scaffolder.service';
import { PlatformAccessService, Actor } from './platform-access.service';
import { InternalAccountsSyncService } from '../generator/internal-accounts-sync.service';
import { ProvisioningService } from '../generator/provisioning.service';
import { AuditLogService } from '../audit/audit-log.service';
import { AUDIT_ACTIONS, AuditAction } from '../common/constants/audit-actions';
import { AUDIT_TARGETS } from '../common/constants/audit-target.constant';

/** Name of the system role every platform is seeded with at creation time - see `create()`. */
export const SYSTEM_ADMIN_ROLE_NAME = 'ADMIN';

/**
 * Domain Service managing platform resources lifecycle, RBAC access checks,
 * membership management, and two-step member removal workflows.
 */
@Injectable()
export class PlatformsService {
    private readonly logger = new Logger(PlatformsService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly runtimeManager: DockerRuntimeManagerService,
        private readonly scaffolder: ProjectScaffolderService,
        private readonly access: PlatformAccessService,
        private readonly internalAccountsSync: InternalAccountsSyncService,
        private readonly provisioning: ProvisioningService,
        private readonly auditLog: AuditLogService,
    ) {}

    /** SEC-027: platform operations are audited; an audit failure never blocks the operation. */
    private async audit(
        actorId: string | null,
        action: AuditAction,
        platformId: string,
        metadata: Record<string, unknown> = {},
    ) {
        try {
            await this.auditLog.log({
                action,
                actorId,
                targetType: AUDIT_TARGETS.PLATFORM,
                targetId: platformId,
                metadata: metadata as never,
            });
        } catch (error) {
            this.logger.error(
                `Audit log failed for ${action} on ${platformId}.`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }

    /**
     * Creates a new platform entity owned by the requesting actor, and seeds its system "ADMIN"
     * role in the same transaction - every platform must have exactly one `isSystem: true` role
     * from the moment it exists, since `PlatformMember.platformRoleId` is required (there is no
     * "member with no role" state - see `PlatformMember` in schema.prisma).
     */
    async create(actor: Actor, dto: CreatePlatformDto) {
        const slug = await this.generateUniqueSlug(dto.name);

        return this.prisma
            .$transaction(async (tx) => {
                const platform = await tx.platform.create({
                    data: {
                        name: dto.name,
                        description: dto.description,
                        url: dto.url,
                        slug,
                        ownerId: actor.userId,
                    },
                });

                await tx.platformRole.create({
                    data: { platformId: platform.id, name: SYSTEM_ADMIN_ROLE_NAME, isSystem: true },
                });

                return platform;
            })
            .then(async (platform) => {
                await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_CREATE, platform.id, { slug: platform.slug });
                return platform;
            });
    }

    /**
     * Lists platforms accessible to the actor.
     * Actors with global read permissions see all platforms; others see only owned/joined platforms.
     */
    async list(actor: Actor, includeArchived = false) {
        const canSeeAll = actor.permissions.includes(PERMISSIONS.PLATFORM_READ);

        return this.prisma.platform.findMany({
            where: {
                ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }),
                ...(canSeeAll
                    ? {}
                    : {
                          OR: [{ ownerId: actor.userId }, { members: { some: { userId: actor.userId } } }],
                      }),
            },

            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Retrieves a single platform by ID after verifying the actor has read access.
     */
    async getById(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        await this.assertCanView(actor, platform);
        return platform;
    }

    /**
     * Updates platform details. Requires ADMIN role or global update permission.
     */
    async update(actor: Actor, id: string, dto: UpdatePlatformDto) {
        const platform = await this.findPlatformOrThrow(id);
        await this.access.assertHasPermission(
            actor,
            platform,
            PLATFORM_PERMISSIONS.PLATFORM_UPDATE,
            PERMISSIONS.PLATFORM_UPDATE,
        );

        return this.prisma.platform.update({ where: { id }, data: dto });
    }

    /**
     * Soft-deletes/archives a platform. Reserved for owner or global delete permission holders.
     *
     * Two things happen together, deliberately, so "archived" actually means something rather
     * than just hiding the platform from the default list view:
     *   1. Its runtime is stopped, if currently running - an archived platform has no business
     *      still occupying CPU/RAM/a port on the host indefinitely. Best-effort: a stop failure
     *      is logged but never blocks archiving itself (the platform still gets archived even
     *      if, say, Docker is temporarily unreachable - the retention-window purge below will
     *      simply retry the stop when it runs).
     *   2. `archivedAt` is stamped with the current time - `CleanupService` permanently deletes
     *      this platform once `archivedAt` is more than the configured retention window (default
     *      30 days) in the past. See `restore()` for why re-archiving later always restarts this
     *      countdown from zero instead of resuming it.
     */
    async archive(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status === 'ARCHIVED') {
            throw new BadRequestException('This platform is already archived.');
        }

        await this.stopRuntimeBestEffort(platform.id);

        // GEN-005: requests not yet started are abandoned; a RUNNING generation notices the
        // ARCHIVED status and leaves it untouched when it finishes.
        await this.prisma.generation.updateMany({
            where: { platformId: id, status: { in: ['PENDING', 'AWAITING_APPROVAL'] } },
            data: { status: 'FAILED', errorMsg: 'Platform archived.', finishedAt: new Date() },
        });

        const archived = await this.prisma.platform.update({
            where: { id },
            data: { status: 'ARCHIVED', archivedAt: new Date() },
        });
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_ARCHIVED, id);
        return archived;
    }

    /**
     * Restores an archived platform back to DRAFT status and clears `archivedAt` - this is what
     * makes the 30-day countdown restart from zero rather than resume if the platform is
     * archived again later: `archive()` always writes a brand new timestamp, and there is no
     * trace of the earlier one left to fall back to.
     */
    async restore(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status !== 'ARCHIVED') {
            throw new BadRequestException('This platform is not archived.');
        }
        const restored = await this.prisma.platform.update({
            where: { id },
            data: { status: 'DRAFT', archivedAt: null },
        });
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_RESTORED, id);
        return restored;
    }

    /**
     * Permanently and irreversibly deletes a platform: stops its runtime if still running,
     * removes its generated project directory from disk, then deletes its database row (cascade
     * rules in schema.prisma take care of its entities/fields/relations/generations/database
     * record/planning; Clients and Projects are decoupled via `onDelete: SetNull` rather than
     * deleted, since that business data can outlive the platform it was modeled on).
     *
     * Requires the platform to already be ARCHIVED - there is no direct "delete a live platform"
     * path. This is intentional: archiving first (even if immediately followed by this call) is
     * the only way to permanently delete a platform, so nothing gets permanently destroyed
     * without at least passing through the reversible, visible ARCHIVED state first.
     */
    async purge(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status !== 'ARCHIVED') {
            throw new BadRequestException(
                'Only an archived platform can be permanently deleted. Archive it first with ' +
                    'DELETE /platforms/:id.',
            );
        }

        await this.purgePlatform(platform.id, platform.slug);
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_PURGED, platform.id, { slug: platform.slug });
        return { message: 'Platform permanently deleted.' };
    }

    /**
     * Called daily by `CleanupService`. Permanently deletes every platform that has been
     * continuously ARCHIVED for longer than `retentionDays` - see `purge()` for exactly what
     * "permanently deleted" removes. Each platform is purged independently inside its own
     * try/catch so one failure (e.g. a locked file, a Docker hiccup) never blocks the rest of
     * the batch; the caller (CleanupService) logs and swallows failures the same way its other
     * cleanup subroutines already do.
     *
     * @returns The count of platforms permanently deleted.
     */
    async purgeExpiredArchives(retentionDays: number): Promise<number> {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const expired = await this.prisma.platform.findMany({
            where: { status: 'ARCHIVED', archivedAt: { not: null, lt: cutoff } },
            select: { id: true, slug: true },
        });

        let purgedCount = 0;
        for (const platform of expired) {
            try {
                await this.purgePlatform(platform.id, platform.slug);
                await this.audit(null, AUDIT_ACTIONS.PLATFORM_PURGED, platform.id, {
                    slug: platform.slug,
                    reason: 'retention',
                });
                purgedCount++;
            } catch (error) {
                this.logger.error(
                    `Failed to auto-purge archived platform ${platform.id} (${platform.slug}) ` +
                        `after retention window expired.`,
                    error instanceof Error ? error.stack : String(error),
                );
            }
        }

        return purgedCount;
    }

    /**
     * Shared implementation behind `purge()` (manual, immediate) and `purgeExpiredArchives()`
     * (automatic, after the retention window) - stop runtime, remove files, delete the row.
     * Each step is best-effort/defensive on its own: a platform that was already stopped, or
     * whose generated directory was already removed, must not make the overall purge fail.
     */
    private async purgePlatform(platformId: string, slug: string): Promise<void> {
        // Scenario F of the audit: never delete files and database under a running generation.
        const running = await this.prisma.generation.count({ where: { platformId, status: 'RUNNING' } });
        if (running > 0) {
            throw new ConflictException(
                'A generation is still running for this platform. Cancel it or wait for it to finish.',
            );
        }

        await this.stopRuntimeBestEffort(platformId);

        // DATA FIX (DB-001): drop the platform's PostgreSQL database and role. This method existed
        // but was never called, so "permanently deleted" platforms kept their end users' data and
        // a LOGIN role forever. A failure aborts the purge (retried by the next cleanup run).
        await this.provisioning.deprovisionDatabaseForPlatform(platformId);

        try {
            await fs.rm(this.scaffolder.getSlugRootPath(slug), { recursive: true, force: true });
        } catch (error) {
            // `force: true` already swallows ENOENT (directory never existed / already
            // removed); anything else is worth knowing about but must not abort the purge -
            // the database row is the source of truth, and leaving one directory behind is a
            // far smaller problem than leaving the platform (and its running container, if the
            // stop above failed too) permanently un-deletable.
            this.logger.warn(
                `Could not fully remove generated files for platform ${platformId} (${slug}) ` + `during purge.`,
                error instanceof Error ? error.stack : String(error),
            );
        }

        // Cascade rules in schema.prisma handle every dependent row from here.
        await this.prisma.platform.delete({ where: { id: platformId } });
    }

    /**
     * Stops a platform's Docker runtime if it is currently running, swallowing the "not
     * currently running" case (nothing to do) and logging - but never throwing - any other
     * failure, since this is always called as a side effect of archiving/purging, never as the
     * primary action the caller is waiting on.
     */
    private async stopRuntimeBestEffort(platformId: string): Promise<void> {
        try {
            await this.runtimeManager.stop(platformId);
        } catch (error) {
            if (error instanceof BadRequestException) {
                // "This backend is not currently running." - expected and fine.
                return;
            }
            this.logger.warn(
                `Could not stop runtime for platform ${platformId} while archiving/purging it.`,
                error instanceof Error ? error.stack : String(error),
            );
        }
    }

    /**
     * Reassigns platform ownership to a different active user.
     */
    async transferOwnership(actor: Actor, id: string, dto: TransferOwnershipDto) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_TRANSFER_OWNERSHIP);

        const newOwner = await this.prisma.user.findUnique({ where: { id: dto.newOwnerId } });
        if (!newOwner || newOwner.status !== UserStatus.ACTIVE) {
            throw new BadRequestException('The new owner is invalid or inactive.');
        }

        if (dto.newOwnerId === platform.ownerId) {
            throw new BadRequestException('This user already owns the platform.');
        }
        // Ownership can only go to someone already working on the platform (no platform can be
        // pushed onto an arbitrary user, who would then be unable to delete their account).
        const newOwnerMembership = await this.getMembership(dto.newOwnerId, id);
        if (!newOwnerMembership) {
            throw new BadRequestException('The new owner must already be a member of this platform.');
        }
        const adminRole = await this.prisma.platformRole.findFirst({ where: { platformId: id, isSystem: true } });

        const updated = await this.prisma.$transaction(async (tx) => {
            await tx.platformMember.delete({ where: { id: newOwnerMembership.id } });
            const result = await tx.platform.update({ where: { id }, data: { ownerId: dto.newOwnerId } });
            // The previous owner keeps working on the platform as ADMIN instead of losing all access.
            if (adminRole) {
                await tx.platformMember.upsert({
                    where: { platformId_userId: { platformId: id, userId: platform.ownerId } },
                    update: { platformRoleId: adminRole.id },
                    create: { platformId: id, userId: platform.ownerId, platformRoleId: adminRole.id },
                });
            }
            return result;
        });
        // The new owner gets an internal account on the generated backend right away.
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_OWNERSHIP_TRANSFERRED, id, {
            from: platform.ownerId,
            to: dto.newOwnerId,
        });
        void this.internalAccountsSync.notify(id);
        return updated;
    }

    // ---- Members ----

    /**
     * Lists all members associated with a specific platform.
     */
    async listMembers(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertCanView(actor, platform);

        return this.prisma.platformMember.findMany({
            where: { platformId },
            include: {
                user: { select: { id: true, username: true, workEmail: true, firstName: true, lastName: true } },
                platformRole: { select: { id: true, name: true, isSystem: true } },
            },
        });
    }

    /**
     * The caller's own effective access on this platform, for the UI to gate buttons and tabs:
     * whether they are the owner / an ADMIN, their role name, and the platform permission keys they
     * hold. Purely informative - every action is still re-checked server-side.
     */
    async getMyAccess(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertCanView(actor, platform);

        const { isOwner, isAdmin, permissions } = await this.access.getEffectivePermissions(actor, platform);
        const membership = isOwner
            ? null
            : await this.prisma.platformMember.findUnique({
                  where: { platformId_userId: { platformId, userId: actor.userId } },
                  select: { platformRole: { select: { id: true, name: true, isSystem: true } } },
              });

        return {
            isOwner,
            isAdmin,
            role: membership?.platformRole ?? null,
            permissions: Array.from(permissions),
        };
    }

    /**
     * Adds a user as a member or updates their existing role within the platform.
     */
    async addMember(actor: Actor, platformId: string, dto: AddMemberDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.access.assertHasPermission(
            actor,
            platform,
            PLATFORM_PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
            PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
        );
        const role = await this.resolveRoleOrThrow(platformId, dto.platformRoleId);
        await this.assertCanGrantRole(actor, platform, role);

        if (dto.userId === platform.ownerId) {
            throw new BadRequestException('The owner does not need to be added as a member.');
        }
        const targetUser = await this.prisma.user.findUnique({ where: { id: dto.userId } });
        if (!targetUser || targetUser.status !== UserStatus.ACTIVE) {
            throw new BadRequestException('Invalid or inactive user.');
        }
        // SEC-006: `upsert` also changes the role of an EXISTING member.
        await this.assertCanManageExistingMember(actor, platform, dto.userId);

        const member = await this.prisma.platformMember.upsert({
            where: { platformId_userId: { platformId, userId: dto.userId } },
            update: { platformRoleId: role.id },
            create: { platformId, userId: dto.userId, platformRoleId: role.id },
        });
        // Immediate effect on the generated backend: an ADMIN / data-role member gets their
        // internal account created now (no restart, no regeneration) - see InternalAccountsSyncService.
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_MEMBER_ADDED, platformId, {
            userId: dto.userId,
            platformRoleId: role.id,
        });
        void this.internalAccountsSync.notify(platformId);
        return member;
    }

    /**
     * Updates an existing platform member's assigned role.
     */
    async updateMemberRole(actor: Actor, platformId: string, targetUserId: string, dto: UpdateMemberRoleDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.access.assertHasPermission(
            actor,
            platform,
            PLATFORM_PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
            PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
        );
        const role = await this.resolveRoleOrThrow(platformId, dto.platformRoleId);
        await this.assertCanGrantRole(actor, platform, role);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('This member is not part of the platform.');
        await this.assertCanManageExistingMember(actor, platform, targetUserId);

        const updated = await this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { platformRoleId: role.id },
        });
        // Gaining OR losing data access changes who holds an internal account.
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_MEMBER_ROLE_CHANGED, platformId, {
            userId: targetUserId,
            platformRoleId: role.id,
        });
        void this.internalAccountsSync.notify(platformId);
        return updated;
    }

    /**
     * Initiates member removal. Immediate deletion if requested by owner/super-admin,
     * otherwise flags a pending removal request requiring confirmation.
     */
    async removeMember(actor: Actor, platformId: string, targetUserId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.access.assertHasPermission(
            actor,
            platform,
            PLATFORM_PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
            PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
        );

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('This member is not part of the platform.');

        const isOwnerOrGlobal =
            platform.ownerId === actor.userId || actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        if (!isOwnerOrGlobal) {
            await this.assertCanManageExistingMember(actor, platform, targetUserId);
        }

        if (isOwnerOrGlobal) {
            await this.prisma.platformMember.delete({ where: { id: membership.id } });
            await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_MEMBER_REMOVED, platformId, { userId: targetUserId });
            void this.internalAccountsSync.notify(platformId);
            return { message: 'Member removed.', status: 'removed' };
        }

        if (membership.removalRequestedAt) {
            throw new ConflictException('A removal request is already pending for this member.');
        }

        const updated = await this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { removalRequestedAt: new Date(), removalRequestedById: actor.userId },
        });

        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_MEMBER_REMOVAL_REQUESTED, platformId, {
            userId: targetUserId,
        });
        return { ...updated, status: 'pending_approval' };
    }

    /**
     * Confirms and executes a pending member removal request.
     */
    async confirmMemberRemoval(actor: Actor, platformId: string, targetUserId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('This member is not part of the platform.');
        if (!membership.removalRequestedAt) {
            throw new BadRequestException('No pending removal request for this member.');
        }

        await this.prisma.platformMember.delete({ where: { id: membership.id } });
        await this.audit(actor.userId, AUDIT_ACTIONS.PLATFORM_MEMBER_REMOVED, platformId, {
            userId: targetUserId,
            confirmed: true,
        });
        // Their internal account on the generated backend is revoked right away.
        void this.internalAccountsSync.notify(platformId);
        return { message: 'Removal confirmed, member deleted.' };
    }

    /**
     * Cancels a pending member removal request.
     */
    async cancelMemberRemoval(actor: Actor, platformId: string, targetUserId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('This member is not part of the platform.');
        if (!membership.removalRequestedAt) {
            throw new BadRequestException('No pending removal request for this member.');
        }

        const isOwnerOrGlobal =
            platform.ownerId === actor.userId || actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        const isRequester = membership.removalRequestedById === actor.userId;

        if (!isOwnerOrGlobal && !isRequester) {
            throw new ForbiddenException('You cannot cancel this request.');
        }

        return this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { removalRequestedAt: null, removalRequestedById: null },
        });
    }

    // ---- Helpers ----

    /**
     * Helper retrieving a platform entity or throwing a 404 exception.
     */
    private async findPlatformOrThrow(id: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id } });
        if (!platform) throw new NotFoundException('Platform not found.');
        return platform;
    }

    /**
     * Helper retrieving membership record for a specific user and platform.
     */
    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
        });
    }

    /**
     * Asserts actor has read permissions for the platform (Owner, Global Reader, or Member).
     */
    private async assertCanView(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.getMembership(actor.userId, platform.id);
        if (!membership) {
            throw new NotFoundException('Platform not found.');
        }
    }

    /**
     * Asserts action is executed by the platform owner or an actor with global permission.
     */
    private assertOwnerOrGlobalPermission(actor: Actor, platform: { ownerId: string }, globalPermission: string) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(globalPermission)) return;
        throw new ForbiddenException('Action reserved for the platform owner.');
    }

    /**
     * Resolves a `platformRoleId` to its row (with permissions loaded), or throws if it doesn't
     * exist or belongs to a different platform than the one being acted on.
     */
    private async resolveRoleOrThrow(platformId: string, platformRoleId: string) {
        const role = await this.prisma.platformRole.findUnique({
            where: { id: platformRoleId },
            include: { rolePermissions: { include: { platformPermission: true } } },
        });
        if (!role || role.platformId !== platformId) {
            throw new BadRequestException('This role does not exist on this platform.');
        }
        return role;
    }

    /**
     * Restricts who can grant `role` to a member:
     * - the system ADMIN role: only the platform owner, or a global member-manager - exactly the
     *   pre-existing "only the owner can assign another admin" rule.
     * - a custom role: the granting actor must themselves hold, on this platform, every
     *   permission the role carries - the same permission-ceiling rule
     *   `PlatformRolesService.assertGrantablePermissions()` applies when the role is *created*,
     *   applied again here because the actor granting an existing role to a member may not be
     *   the same actor who created it.
     */
    private async assertCanGrantRole(
        actor: Actor,
        platform: { id: string; ownerId: string },
        role: { isSystem: boolean; rolePermissions: { platformPermission: { key: string } }[] },
    ) {
        if (role.isSystem) {
            if (platform.ownerId === actor.userId) return;
            if (actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS)) return;
            throw new ForbiddenException('Only the platform owner can assign the ADMIN role.');
        }

        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        const roleKeys = role.rolePermissions.map((rp) => rp.platformPermission.key);
        const notOwned = roleKeys.filter((key) => !permissions.has(key as never));
        if (notOwned.length > 0) {
            throw new ForbiddenException(
                `You cannot assign a role that carries permission(s) you do not hold yourself: ${notOwned.join(', ')}.`,
            );
        }
    }

    /**
     * Generates a unique, URL-safe slug by appending numerical suffixes on collisons.
     */
    /**
     * SECURITY FIX (SEC-006): member management used to check only the NEW role being assigned,
     * never the CURRENT one of the target - a member holding `platform.manage-members` could
     * demote the platform's ADMIN. Outside the owner and global managers, an actor can only act
     * on members whose current permissions are a subset of their own, and never on an ADMIN.
     */
    private async assertCanManageExistingMember(
        actor: Actor,
        platform: { id: string; ownerId: string },
        targetUserId: string,
    ): Promise<void> {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS)) return;
        if (targetUserId === actor.userId) {
            throw new ForbiddenException('You cannot change your own membership.');
        }

        const target = await this.access.getEffectivePermissions({ userId: targetUserId, permissions: [] }, platform);
        if (target.isAdmin) {
            throw new ForbiddenException('Only the platform owner can change or remove an ADMIN.');
        }
        const mine = await this.access.getEffectivePermissions(actor, platform);
        const exceeding = Array.from(target.permissions).filter((key) => !mine.permissions.has(key));
        if (exceeding.length > 0) {
            throw new ForbiddenException(
                `You cannot manage a member holding permission(s) you do not have: ${exceeding.join(', ')}.`,
            );
        }
    }

    private async generateUniqueSlug(name: string): Promise<string> {
        const base = slugify(name);
        let candidate = base;
        let counter = 2;
        while (await this.prisma.platform.findUnique({ where: { slug: candidate } })) {
            candidate = `${base}-${counter}`;
            counter++;
        }
        return candidate;
    }
}
