import {
    Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRelationDto } from './dto/create-relation.dto';
import { sanitizeRelationFieldName } from '../common/utils/relation-name.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

type Actor = { userId: string; permissions: string[] };

@Injectable()
export class RelationsService {

    constructor(private readonly prisma: PrismaService) {}

    async list(actor: Actor, platformId: string) {
        await this.assertCanView(actor, platformId);
        return this.prisma.relation.findMany({
            where: { platformId },
            include: { entityA: true, entityB: true },
            orderBy: { createdAt: 'asc' },
        });
    }

    async create(actor: Actor, platformId: string, dto: CreateRelationDto) {

        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);

        const [entityA, entityB] = await Promise.all([
            this.getEntityInPlatformOrThrow(platformId, dto.entityAId),
            this.getEntityInPlatformOrThrow(platformId, dto.entityBId),
        ]);

        const fieldNameOnA = sanitizeRelationFieldName(dto.fieldNameOnA);
        const fieldNameOnB = sanitizeRelationFieldName(dto.fieldNameOnB);

        await this.assertFieldNameAvailable(entityA.id, fieldNameOnA);
        await this.assertFieldNameAvailable(entityB.id, fieldNameOnB);

        return this.prisma.relation.create({
            data: {
                platformId,
                type: dto.type,
                entityAId: entityA.id,
                entityBId: entityB.id,
                fieldNameOnA,
                fieldNameOnB,
            },
            include: { entityA: true, entityB: true },
        });
    }

    async delete(actor: Actor, platformId: string, relationId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);

        const relation = await this.prisma.relation.findFirst({ where: { id: relationId, platformId } });
        if (!relation) throw new NotFoundException('Relation introuvable.');

        await this.prisma.relation.delete({ where: { id: relation.id } });
        return { message: 'Relation supprimée.' };
    }

    // ---- Helpers ----

    private async getEntityInPlatformOrThrow(platformId: string, entityId: string) {
        const entity = await this.prisma.entity.findFirst({ where: { id: entityId, platformId } });
        if (!entity) throw new NotFoundException(`Entité introuvable : ${entityId}`);
        return entity;
    }

    private async assertFieldNameAvailable(entityId: string, fieldName: string) {
        const [existingField, existingRelationA, existingRelationB] = await Promise.all([
            this.prisma.field.findFirst({ where: { entityId, column: fieldName } }),
            this.prisma.relation.findFirst({ where: { entityAId: entityId, fieldNameOnA: fieldName } }),
            this.prisma.relation.findFirst({ where: { entityBId: entityId, fieldNameOnB: fieldName } }),
        ]);

        if (existingField || existingRelationA || existingRelationB) {
            throw new BadRequestException(
                `Le nom "${fieldName}" est déjà utilisé (champ ou relation existante) sur cette entité.`,
            );
        }
    }

    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        return platform;
    }

    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
        });
        if (!membership) throw new NotFoundException('Plateforme introuvable.');
    }

    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(permission)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
        });
        if (membership?.role === 'ADMIN') return;

        throw new ForbiddenException(
            'Tu dois être propriétaire, administrateur de la plateforme, ou avoir la permission requise.',
        );
    }
}