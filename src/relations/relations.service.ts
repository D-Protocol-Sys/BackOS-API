import { PlatformAccessService } from '../platforms/platform-access.service';
import { PLATFORM_PERMISSIONS } from '../common/constants/platform-permissions.constant';
import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRelationDto } from './dto/create-relation.dto';
import { sanitizeRelationFieldName } from '../common/utils/relation-name.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

/**
 * Type defining the requesting user (actor) details, including ID and global system permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Domain Service managing entity relations (ORMs relationships like 1-N, N-N),
 * enforcing unique field naming across models and strict platform RBAC access rules.
 */
@Injectable()
export class RelationsService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly access: PlatformAccessService,
    ) {}

    /**
     * Lists all relations defined within a given platform scope.
     * Includes both related entities (Entity A and Entity B) in the returned payload.
     */
    async list(actor: Actor, platformId: string) {
        await this.assertCanView(actor, platformId);
        return this.prisma.relation.findMany({
            where: { platformId },
            include: { entityA: true, entityB: true },
            orderBy: { createdAt: 'asc' },
        });
    }

    /**
     * Creates a new relation between two entities inside the same platform.
     * Sanitizes field names and ensures field name availability on both entities.
     */
    async create(actor: Actor, platformId: string, dto: CreateRelationDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);

        // Fetch and validate that both target entities belong to the target platform concurrently
        const [entityA, entityB] = await Promise.all([
            this.getEntityInPlatformOrThrow(platformId, dto.entityAId),
            this.getEntityInPlatformOrThrow(platformId, dto.entityBId),
        ]);

        const fieldNameOnA = sanitizeRelationFieldName(dto.fieldNameOnA);
        const fieldNameOnB = sanitizeRelationFieldName(dto.fieldNameOnB);

        // Ensure sanitized field names are not already taken by columns or other relations
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

    /**
     * Deletes an existing relation by ID within a platform scope.
     */
    async delete(actor: Actor, platformId: string, relationId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);

        const relation = await this.prisma.relation.findFirst({ where: { id: relationId, platformId } });
        if (!relation) throw new NotFoundException('Relation not found.');

        await this.prisma.relation.delete({ where: { id: relation.id } });
        return { message: 'Relation deleted.' };
    }

    // ---- Helpers ----

    /**
     * Helper verifying that a given entity exists and belongs strictly to the designated platform.
     */
    private async getEntityInPlatformOrThrow(platformId: string, entityId: string) {
        const entity = await this.prisma.entity.findFirst({ where: { id: entityId, platformId } });
        if (!entity) throw new NotFoundException(`Entity not found: ${entityId}`);
        return entity;
    }

    /**
     * Helper asserting that a relation field name does not collide with existing table columns
     * or existing relationship field names on either side of the relation.
     */
    private async assertFieldNameAvailable(entityId: string, fieldName: string) {
        const [existingField, existingRelationA, existingRelationB] = await Promise.all([
            this.prisma.field.findFirst({ where: { entityId, column: fieldName } }),
            this.prisma.relation.findFirst({ where: { entityAId: entityId, fieldNameOnA: fieldName } }),
            this.prisma.relation.findFirst({ where: { entityBId: entityId, fieldNameOnB: fieldName } }),
        ]);

        if (existingField || existingRelationA || existingRelationB) {
            throw new BadRequestException(
                `The name "${fieldName}" is already in use (existing field or relation) on this entity.`,
            );
        }
    }

    /**
     * Helper retrieving a platform entity or throwing a 404 exception.
     */
    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        return platform;
    }

    /**
     * Asserts actor has read access to the platform (Owner, Global Reader, or Platform Member).
     */
    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId: actor.userId } },
        });
        if (!membership) throw new NotFoundException('Platform not found.');
    }

    /**
     * Asserts actor has write permissions for modifying platform entities/relations
     * (Platform Owner, Global Permission Holder, or Platform ADMIN).
     */
    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(permission)) return;

        // Platform-level check: ADMIN implicitly, or a custom role carrying `entity.manage`.
        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        if (permissions.has(PLATFORM_PERMISSIONS.ENTITY_MANAGE)) return;

        throw new ForbiddenException(
            'You must be the platform owner, an administrator, or hold the required permission.',
        );
    }
}
