import {
    Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { toSqlIdentifier } from '../common/utils/sql-identifier.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

type Actor = { userId: string; permissions: string[] };

@Injectable()
export class EntitiesService {

    constructor(private readonly prisma: PrismaService) {}

    async list(actor: Actor, platformId: string, includeArchived = false) {
        await this.assertCanView(actor, platformId);
        return this.prisma.entity.findMany({
            where: { platformId, ...(includeArchived ? {} : { isArchived: false }) },
            include: { fields: { orderBy: { order: 'asc' } } },
            orderBy: { createdAt: 'asc' },
        });
    }

    async getById(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanView(actor, platformId);
        const entity = await this.findEntityOrThrow(platformId, entityId);
        return this.prisma.entity.findUnique({
            where: { id: entity.id },
            include: { fields: { orderBy: { order: 'asc' } } },
        });
    }

    async create(actor: Actor, platformId: string, dto: CreateEntityDto) {
        const platform = await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_CREATE);
        const tableName = await this.generateUniqueTableName(platformId, dto.name);

        return this.prisma.entity.create({
            data: { name: dto.name, tableName, platformId: platform.id },
        });
    }

    async update(actor: Actor, platformId: string, entityId: string, dto: UpdateEntityDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        return this.prisma.entity.update({ where: { id: entity.id }, data: { name: dto.name } });
    }

    async setSchedulable(actor: Actor, platformId: string, entityId: string, enabled: boolean) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        if (enabled) {
            const schedulerActive = await this.prisma.platformService.findUnique({
                where: { platformId_serviceKey: { platformId, serviceKey: 'scheduler' } },
            });
            if (!schedulerActive) {
                throw new BadRequestException(
                    'Le service "Scheduler" doit être activé sur cette plateforme avant de rendre une entité programmable.',
                );
            }
        }

        return this.prisma.entity.update({ where: { id: entity.id }, data: { isSchedulable: enabled } });
    }

    async archive(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_DELETE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        if (entity.isArchived) throw new BadRequestException('Cette entité est déjà archivée.');
        return this.prisma.entity.update({ where: { id: entity.id }, data: { isArchived: true } });
    }

    async restore(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_DELETE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        if (!entity.isArchived) throw new BadRequestException("Cette entité n'est pas archivée.");
        return this.prisma.entity.update({ where: { id: entity.id }, data: { isArchived: false } });
    }

    async delete(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanDelete(actor, platformId, PERMISSIONS.ENTITY_DELETE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        await this.prisma.entity.delete({ where: { id: entity.id } });
        return { message: 'Entité supprimée définitivement.' };
    }

    // ---- Helpers ----

    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        return platform;
    }

    private async findEntityOrThrow(platformId: string, entityId: string) {
        const entity = await this.prisma.entity.findFirst({ where: { id: entityId, platformId } });
        if (!entity) throw new NotFoundException('Entité introuvable.');
        return entity;
    }

    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
        });
    }

    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.getMembership(actor.userId, platformId);
        if (!membership) throw new NotFoundException('Plateforme introuvable.');
    }

    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        const membership = await this.getMembership(actor.userId, platformId);
        if (membership?.role === 'ADMIN') return platform;

        throw new ForbiddenException(
            "Tu dois être propriétaire, administrateur de la plateforme, ou avoir la permission requise.",
        );
    }

    private async assertCanDelete(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        throw new ForbiddenException(
            'Seul le propriétaire de la plateforme peut supprimer définitivement. Tu peux archiver à la place.',
        );
    }

    private async generateUniqueTableName(platformId: string, name: string): Promise<string> {
        const base = toSqlIdentifier(name, 'entity');
        let candidate = base;
        let counter = 2;
        while (
            await this.prisma.entity.findUnique({ where: { platformId_tableName: { platformId, tableName: candidate } } })
        ) {
            candidate = `${base}_${counter}`;
            counter++;
        }
        return candidate;
    }

}
