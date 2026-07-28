import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class RoleHierarchyService {

    constructor(private readonly prisma: PrismaService) {}

    async getBestLevel(userId: string): Promise<number | null> {
        const userRoles = await this.prisma.userRole.findMany({
            where: { userId },
            include: { role: true },
        });
        if (userRoles.length === 0) return null;
        return Math.min(...userRoles.map((ur) => ur.role.level));
    }

    async assertSeniorToTarget(actorUserId: string, targetUserId: string, action: string) {
        if (actorUserId === targetUserId) return;

        const actorLevel = await this.getBestLevel(actorUserId);
        const targetLevel = await this.getBestLevel(targetUserId);

        if (actorLevel === null) {
            throw new ForbiddenException('Aucun rôle assigné, action impossible.');
        }
        if (targetLevel === null) return;

        if (actorLevel >= targetLevel) {
            throw new ForbiddenException(
                `Impossible de ${action} un utilisateur de rang égal ou supérieur au tien.`,
            );
        }
    }

    async assertCanGrantRole(actorUserId: string, roleId: string) {
        const actorLevel = await this.getBestLevel(actorUserId);
        const role = await this.prisma.role.findUnique({ where: { id: roleId } });
        if (!role) throw new NotFoundException('Rôle introuvable.');

        if (actorLevel === null || actorLevel >= role.level) {
            throw new ForbiddenException(
                "Impossible d'assigner un rôle de rang égal ou supérieur au tien.",
            );
        }
    }

    async assertCanCreateAtLevel(actorUserId: string, level: number) {
        const actorLevel = await this.getBestLevel(actorUserId);
        if (actorLevel === null || level <= actorLevel) {
            throw new ForbiddenException(
                'Impossible de créer un rôle de rang égal ou supérieur au tien.',
            );
        }
    }
}