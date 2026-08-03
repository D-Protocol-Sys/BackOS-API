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
import { PlatformRole } from '@prismamodels/client';

type Actor = { userId: string; permissions: string[] };

const ROLE_WEIGHT: Record<PlatformRole, number> = {
    VIEWER: 1,
    EDITOR: 2,
    ADMIN: 3,
};

@Injectable()
export class PlatformsService {

    constructor(private readonly prisma: PrismaService) {}

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

    async getById(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        await this.assertCanView(actor, platform);
        return platform;
    }

    async update(actor: Actor, id: string, dto: UpdatePlatformDto) {
        const platform = await this.findPlatformOrThrow(id);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_UPDATE);

        return this.prisma.platform.update({ where: { id }, data: dto });
    }

    async archive(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status === 'ARCHIVED') {
            throw new BadRequestException('Cette plateforme est déjà archivée.');
        }
        return this.prisma.platform.update({ where: { id }, data: { status: 'ARCHIVED' } });
    }

    async restore(actor: Actor, id: string) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_DELETE);

        if (platform.status !== 'ARCHIVED') {
            throw new BadRequestException("Cette plateforme n'est pas archivée.");
        }
        return this.prisma.platform.update({ where: { id }, data: { status: 'DRAFT' } });
    }

    async transferOwnership(actor: Actor, id: string, dto: TransferOwnershipDto) {
        const platform = await this.findPlatformOrThrow(id);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_TRANSFER_OWNERSHIP);

        const newOwner = await this.prisma.user.findUnique({ where: { id: dto.newOwnerId } });
        if (!newOwner || !newOwner.isActive) {
            throw new BadRequestException('Le nouveau propriétaire est invalide ou inactif.');
        }

        return this.prisma.platform.update({ where: { id }, data: { ownerId: dto.newOwnerId } });
    }

    // ---- Membres ----

    async listMembers(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertCanView(actor, platform);

        return this.prisma.platformMember.findMany({
            where: { platformId },
            include: { user: { select: { id: true, email: true, firstName: true, lastName: true } } },
        });
    }

    async addMember(actor: Actor, platformId: string, dto: AddMemberDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        this.assertCanGrantRole(actor, platform, dto.role);

        if (dto.userId === platform.ownerId) {
            throw new BadRequestException('Le propriétaire n\'a pas besoin d\'être ajouté comme membre.');
        }
        const targetUser = await this.prisma.user.findUnique({ where: { id: dto.userId } });
        if (!targetUser || !targetUser.isActive) {
            throw new BadRequestException('Utilisateur invalide ou inactif.');
        }

        return this.prisma.platformMember.upsert({
            where: { platformId_userId: { platformId, userId: dto.userId } },
            update: { role: dto.role },
            create: { platformId, userId: dto.userId, role: dto.role },
        });
    }

    async updateMemberRole(actor: Actor, platformId: string, targetUserId: string, dto: UpdateMemberRoleDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        this.assertCanGrantRole(actor, platform, dto.role);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('Ce membre ne fait pas partie de la plateforme.');

        return this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { role: dto.role },
        });
    }

    async removeMember(actor: Actor, platformId: string, targetUserId: string) {

        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertHasAtLeastRole(actor, platform, PlatformRole.ADMIN, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('Ce membre ne fait pas partie de la plateforme.');

        const isOwnerOrGlobal =
            platform.ownerId === actor.userId ||
            actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        if (isOwnerOrGlobal) {
            await this.prisma.platformMember.delete({ where: { id: membership.id } });
            return { message: 'Membre retiré.', status: 'removed' };
        }

        if (membership.removalRequestedAt) {
            throw new ConflictException('Une demande de retrait est déjà en attente pour ce membre.');
        }

        const updated = await this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { removalRequestedAt: new Date(), removalRequestedById: actor.userId },
        });

        return { ...updated, status: 'pending_approval' };
    
    }

    async confirmMemberRemoval(actor: Actor, platformId: string, targetUserId: string) {

        const platform = await this.findPlatformOrThrow(platformId);
        this.assertOwnerOrGlobalPermission(actor, platform, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('Ce membre ne fait pas partie de la plateforme.');
        if (!membership.removalRequestedAt) {
            throw new BadRequestException('Aucune demande de retrait en attente pour ce membre.');
        }

        await this.prisma.platformMember.delete({ where: { id: membership.id } });
        return { message: 'Retrait confirmé, membre supprimé.' };
    }

    async cancelMemberRemoval(actor: Actor, platformId: string, targetUserId: string) {

        const platform = await this.findPlatformOrThrow(platformId);
        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: targetUserId } },
        });
        if (!membership) throw new NotFoundException('Ce membre ne fait pas partie de la plateforme.');
        if (!membership.removalRequestedAt) {
            throw new BadRequestException('Aucune demande de retrait en attente pour ce membre.');
        }

        const isOwnerOrGlobal =
            platform.ownerId === actor.userId ||
            actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        const isRequester = membership.removalRequestedById === actor.userId;

        if (!isOwnerOrGlobal && !isRequester) {
            throw new ForbiddenException("Tu ne peux pas annuler cette demande.");
        }

        return this.prisma.platformMember.update({
            where: { id: membership.id },
            data: { removalRequestedAt: null, removalRequestedById: null },
        });
    }

    // ---- Helpers ----

    private async findPlatformOrThrow(id: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        return platform;
    }

    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
        });
    }

    private async assertCanView(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.getMembership(actor.userId, platform.id);
        if (!membership) {
            throw new NotFoundException('Plateforme introuvable.');
        }
    }

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
            throw new ForbiddenException('Action non autorisée sur cette plateforme.');
        }
    }

    private assertOwnerOrGlobalPermission(
        actor: Actor,
        platform: { ownerId: string },
        globalPermission: string,
    ) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(globalPermission)) return;
        throw new ForbiddenException('Action réservée au propriétaire de la plateforme.');
    }

    private assertCanGrantRole(
        actor: Actor,
        platform: { ownerId: string },
        roleToGrant: PlatformRole,
    ) {
        if (roleToGrant !== PlatformRole.ADMIN) return;
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_MANAGE_MEMBERS)) return;

        throw new ForbiddenException(
            'Seul le propriétaire de la plateforme peut désigner un autre manager.',
        );
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
