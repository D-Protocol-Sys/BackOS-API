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
import { PlatformRole, UserStatus } from '@prismamodels/client';
import { DockerRuntimeManagerService } from '../generator/docker-runtime-manager.service';
import { ProjectScaffolderService } from '../generator/project-scaffolder.service';

/**
 * Type defining the requesting user (actor) details, including ID and global system permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Hierarchy weight mapping used to compare platform roles during authorization checks.
 */
const ROLE_WEIGHT: Record<PlatformRole, number> = {
    VIEWER: 1,
    EDITOR: 2,
    ADMIN: 3,
};

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
    ) {}

    /**
     * Creates a new platform entity owned by the requesting actor.
     * Automatically generates a unique URL-friendly slug based on the platform name.
     */
    async create(actor: Actor, dto: CreatePlatformDto) {

        const slug = await this.generateUniqueSlug(dto.name);

        return this.prisma.platform.create({
            data: {
                name: dto.name,
                description: dto.description,
                url: dto.url,
                slug,
                ownerId: actor.userId,
            },
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
                    OR: [
                        { ownerId: actor.userId },
                        { members: { some: { userId: actor.userId } } },
                    ],
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
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_UPDATE);

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

        return this.prisma.platform.update({
            where: { id },
            data: { status: 'ARCHIVED', archivedAt: new Date() },
        });
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
        return this.prisma.platform.update({
            where: { id },
            data: { status: 'DRAFT', archivedAt: null },
        });
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
        await this.stopRuntimeBestEffort(platformId);

        try {
            await fs.rm(this.scaffolder.getSlugRootPath(slug), { recursive: true, force: true });
        } catch (error) {
            // `force: true` already swallows ENOENT (directory never existed / already
            // removed); anything else is worth knowing about but must not abort the purge -
            // the database row is the source of truth, and leaving one directory behind is a
            // far smaller problem than leaving the platform (and its running container, if the
            // stop above failed too) permanently un-deletable.
            this.logger.warn(
                `Could not fully remove generated files for platform ${platformId} (${slug}) ` +
                `during purge.`,
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

        return this.prisma.platform.update({ where: { id }, data: { ownerId: dto.newOwnerId } });
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
            include: { user: { select: { id: true, workEmail: true, firstName: true, lastName: true } } },
        });
    }

    /**
     * Adds a user as a member or updates their existing role within the platform.
     */
    async addMember(actor: Actor, platformId: string, dto: AddMemberDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        this.assertCanGrantRole(actor, platform, dto.role);

        if (dto.userId === platform.ownerId) {
            throw new BadRequestException('The owner does not need to be added as a member.');
        }
        const targetUser = await this.prisma.user.findUnique({ where: { id: dto.userId } });
        if (!targetUser || targetUser.status !== UserStatus.ACTIVE) {
            throw new BadRequestException('Invalid or inactive user.');
        }

        return this.prisma.platformMember.upsert({
            where: { platformId_userId: { platformId, userId: dto.userId } },
            update: { role: dto.role },
            create: { platformId, userId: dto.userId, role: dto.role },
        });
    }

    /**
     * Updates an existing platform member's assigned role.
     */
    async updateMemberRole(actor: Actor, platformId: string, targetUserId: string, dto: UpdateMemberRoleDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        this.assertCanGrantRole(actor, platform, dto.role);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('This member is not part of the platform.');

        return this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { role: dto.role },
        });
    }

    /**
     * Initiates member removal. Immediate deletion if requested by owner/super-admin,
     * otherwise flags a pending removal request requiring confirmation.
     */
    async removeMember(actor: Actor, platformId: string, targetUserId: string) {

        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('This member is not part of the platform.');

        const isOwnerOrGlobal =
            platform.ownerId === actor.userId ||
            actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        if (isOwnerOrGlobal) {
            await this.prisma.platformMember.delete({ where: { id: membership.id } });
            return { message: 'Member removed.', status: 'removed' };
        }

        if (membership.removalRequestedAt) {
            throw new ConflictException('A removal request is already pending for this member.');
        }

        const updated = await this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { removalRequestedAt: new Date(), removalRequestedById: actor.userId },
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
            platform.ownerId === actor.userId ||
            actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
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
     * Asserts actor holds a specific minimum role weight or has global override permissions.
     */
    private async assertHasAtLeastRole(
        actor: Actor,
        platform: { id: string; ownerId: string },
        minRole: PlatformRole,
        globalPermission: string,
    ) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(globalPermission)) return;

        const membership = await this.getMembership(actor.userId, platform.id);
        if (!membership || ROLE_WEIGHT[membership.role] < ROLE_WEIGHT[minRole]) {
            throw new ForbiddenException('Action not authorized on this platform.');
        }
    }

    /**
     * Asserts action is executed by the platform owner or an actor with global permission.
     */
    private assertOwnerOrGlobalPermission(
        actor: Actor,
        platform: { ownerId: string },
        globalPermission: string,
    ) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(globalPermission)) return;
        throw new ForbiddenException('Action reserved for the platform owner.');
    }

    /**
     * Restricts ADMIN role assignments strictly to the platform owner or global member managers.
     */
    private assertCanGrantRole(
        actor: Actor,
        platform: { ownerId: string },
        roleToGrant: PlatformRole,
    ) {
        if (roleToGrant !== PlatformRole.ADMIN) return;
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS)) return;

        throw new ForbiddenException(
            'Only the platform owner can assign another admin.',
        );
    }

    /**
     * Generates a unique, URL-safe slug by appending numerical suffixes on collisons.
     */
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