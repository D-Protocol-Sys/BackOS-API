import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePlatformDto } from './dto/create-platform.dto';
import { UpdatePlatformDto } from './dto/update-platform.dto';
import { TransferOwnershipDto } from './dto/transfer-ownership.dto';
import { AddMemberDto } from './dto/add-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { slugify } from '../common/utils/slugify.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { PlatformRole, UserStatus } from '@prismamodels/client';

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

    constructor(private readonly prisma: PrismaService) {}

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
     */
    async archive(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status === 'ARCHIVED') {
            throw new BadRequestException('This platform is already archived.');
        }
        return this.prisma.platform.update({ where: { id }, data: { status: 'ARCHIVED' } });
    }

    /**
     * Restores an archived platform back to DRAFT status.
     */
    async restore(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status !== 'ARCHIVED') {
            throw new BadRequestException('This platform is not archived.');
        }
        return this.prisma.platform.update({ where: { id }, data: { status: 'DRAFT' } });
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