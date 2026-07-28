import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { RoleHierarchyService } from '../common/services/role-hierarchy.service';

const SAFE_USER_SELECT = {
    id: true,
    email: true,
    firstName: true,
    lastName: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
    userRoles: {
        select: { role: { select: { id: true, name: true } } },
    },
} as const;

@Injectable()
export class UsersService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly roleHierarchy: RoleHierarchyService,
    ) {}

    async getMe(userId: string) {
        return this.prisma.user.findUniqueOrThrow({
            where: { id: userId },
            select: SAFE_USER_SELECT,
        });
    }

    async updateMe(userId: string, dto: UpdateProfileDto) {
        return this.prisma.user.update({
            where: { id: userId },
            data: dto,
            select: SAFE_USER_SELECT,
        });
    }

    async listUsers() {
        return this.prisma.user.findMany({
            select: SAFE_USER_SELECT,
            orderBy: { createdAt: 'asc' },
        });
    }

    async getUserById(id: string) {
        const user = await this.prisma.user.findUnique({
            where: { id },
            select: SAFE_USER_SELECT,
        });
        if (!user) throw new NotFoundException('Utilisateur introuvable.');
        return user;
    }

    async updateUser(id: string, dto: AdminUpdateUserDto) {
        return this.prisma.user.update({
            where: { id },
            data: dto,
            select: SAFE_USER_SELECT,
        });
    }

    async deactivateUser(actorUserId: string, id: string) {
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, id, 'désactiver');
        await this.assertNotProtectedOwner(id, 'désactiver');
        return this.prisma.user.update({
            where: { id },
            data: { isActive: false },
            select: SAFE_USER_SELECT,
        });
    }

    async assignRole(actorUserId: string, userId: string, roleId: string) {

        await this.roleHierarchy.assertSeniorToTarget(actorUserId, userId, 'gérer les rôles de');
        await this.roleHierarchy.assertCanGrantRole(actorUserId, roleId);
  
        await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        await this.prisma.role.findUniqueOrThrow({ where: { id: roleId } });

        return this.prisma.userRole.upsert({
            where: { userId_roleId: { userId, roleId } },
            update: {},
            create: { userId, roleId },
        });
    }

    async removeRole(actorUserId: string, userId: string, roleId: string) {
        await this.roleHierarchy.assertSeniorToTarget(actorUserId, userId, 'gérer les rôles de');
        const role = await this.prisma.role.findUnique({ where: { id: roleId } });
        if (role?.name === 'owner') {
            const ownerCount = await this.prisma.userRole.count({
                where: { roleId },
            });
            if (ownerCount <= 1) {
                throw new ForbiddenException(
                    'Impossible de retirer le dernier owner du système.',
                );
            }
        }

        return this.prisma.userRole.deleteMany({ where: { userId, roleId } });
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
                `Impossible de ${action} le dernier owner du système.`,
            );
        }
    }

    async exportUserData(userId: string) {
        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                firstName: true,
                lastName: true,
                isActive: true,
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

        if (!user) throw new NotFoundException('Utilisateur introuvable.');

        return user;

    }

    async hardDeleteUser(actorUserId: string, userId: string) {

        await this.roleHierarchy.assertSeniorToTarget(actorUserId, userId, 'supprimer');

        const user = await this.prisma.user.findUnique({
            where: { id: userId },
            include: { platformOwned: { select: { id: true } } },
        });

        if (!user) throw new NotFoundException('Utilisateur introuvable.');

        if (user.platformOwned.length > 0) {
            throw new ConflictException(
                'Transfère la propriété de tes plateformes avant de supprimer ce compte.',
            );
        }

        await this.assertNotProtectedOwner(userId, 'supprimer');

        await this.prisma.user.delete({ where: { id: userId } });

        return { message: 'Compte supprimé définitivement.' };
        
    }

}
