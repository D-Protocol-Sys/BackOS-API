import {
    Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prismamodels/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateFieldDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { toSqlIdentifier } from '../common/utils/sql-identifier.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

/**
 * Type definition representing the requesting actor (user context and global permissions).
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Platform statuses that lock destructive migrations (such as column type mutations).
 */
const LOCKED_STATUSES = ['ACTIVE', 'GENERATING'];

/**
 * Service managing individual fields/columns of dynamic entities.
 * Handles field creation, order calculations, type mutation restrictions, soft deletion (archiving), 
 * and automatic SQL column identifier generation.
 */
@Injectable()
export class FieldsService {

    /**
     * @param prisma - Database client providing access to Prisma ORM methods.
     */
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Retrieves all fields defined within a specific entity, ordered by display position.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Parent entity ID.
     * @param includeArchived - Optional flag to include soft-deleted fields in the result set.
     * @returns Array of field records sorted ascending by `order`.
     */
    async list(actor: Actor, platformId: string, entityId: string, includeArchived = false) {
        await this.assertCanView(actor, platformId);
        await this.findEntityOrThrow(platformId, entityId);

        return this.prisma.field.findMany({
            where: { entityId, ...(includeArchived ? {} : { isArchived: false }) },
            orderBy: { order: 'asc' },
        });
    }

    /**
     * Creates a new field within an entity. Generates a unique SQL column name 
     * and sets default position ordering.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Parent entity ID.
     * @param dto - Validated body payload containing field creation details.
     * @returns The newly created field record.
     */
    async create(actor: Actor, platformId: string, entityId: string, dto: CreateFieldDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_CREATE);
        await this.findEntityOrThrow(platformId, entityId);

        // Generates a sanitized SQL column name (e.g., "created_at") with collision handling
        const column = await this.generateUniqueColumn(entityId, dto.name);
        // Automatically appends new field to the end of the ordering sequence
        const order = await this.prisma.field.count({ where: { entityId } });

        return this.prisma.field.create({
            data: {
                entityId,
                name: dto.name,
                column,
                type: dto.type,
                required: dto.required ?? false,
                unique: dto.unique ?? false,
                defaultValue: dto.defaultValue,
                config: dto.config as Prisma.InputJsonValue | undefined,
                order,
            },
        });
    }

    /**
     * Updates field attributes. Prevents data type modifications if the platform 
     * is already in an active or generated deployment state.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     * @param dto - Partial update payload.
     * @throws `BadRequestException` if changing type on a active/generating platform.
     */
    async update(actor: Actor, platformId: string, entityId: string, fieldId: string, dto: UpdateFieldDto) {
        const platform = await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_UPDATE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        // Enforces database safety rule: prevents schema type breaking changes once the platform is live
        if (dto.type && dto.type !== field.type && LOCKED_STATUSES.includes(platform.status)) {
            throw new BadRequestException(
                'Cannot change field type: this platform has already been generated. Delete and recreate the field if necessary.',
            );
        }

        return this.prisma.field.update({
            where: { id: field.id },
            data: {
                ...dto,
                config: dto.config as Prisma.InputJsonValue | undefined,
            },
        });
    }

    /**
     * Soft-deletes a field by setting its `isArchived` flag to true.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     * @throws `BadRequestException` if the field is already archived.
     */
    async archive(actor: Actor, platformId: string, entityId: string, fieldId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        if (field.isArchived) throw new BadRequestException('This field is already archived.');
        return this.prisma.field.update({ where: { id: field.id }, data: { isArchived: true } });
    }

    /**
     * Restores a previously soft-deleted field back to active status.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     * @throws `BadRequestException` if the field is not archived.
     */
    async restore(actor: Actor, platformId: string, entityId: string, fieldId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        if (!field.isArchived) throw new BadRequestException('This field is not archived.');
        return this.prisma.field.update({ where: { id: field.id }, data: { isArchived: false } });
    }

    /**
     * Permanently deletes a field from the database. Restricted strictly to platform owners or superadmins.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     * @returns Success confirmation object.
     */
    async delete(actor: Actor, platformId: string, entityId: string, fieldId: string) {
        await this.assertCanDelete(actor, platformId, PERMISSIONS.FIELD_DELETE);
        await this.findEntityOrThrow(platformId, entityId);
        const field = await this.findFieldOrThrow(entityId, fieldId);

        await this.prisma.field.delete({ where: { id: field.id } });
        return { message: 'Field permanently deleted.' };
    }

    // ---- Helpers ----

    /**
     * Helper: Ensures a platform exists or throws a 404 error.
     */
    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        return platform;
    }

    /**
     * Helper: Ensures an entity exists within a specified platform or throws a 404 error.
     */
    private async findEntityOrThrow(platformId: string, entityId: string) {
        const entity = await this.prisma.entity.findFirst({ where: { id: entityId, platformId } });
        if (!entity) throw new NotFoundException('Entity not found.');
        return entity;
    }

    /**
     * Helper: Ensures a field exists within a specified entity or throws a 404 error.
     */
    private async findFieldOrThrow(entityId: string, fieldId: string) {
        const field = await this.prisma.field.findFirst({ where: { id: fieldId, entityId } });
        if (!field) throw new NotFoundException('Field not found.');
        return field;
    }

    /**
     * Helper: Resolves membership details and roles for a given user within a platform.
     */
    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
        });
    }

    /**
     * Read access: open to any platform member (including VIEWER), platform owner, or global system admin.
     * * @throws `NotFoundException` to obscure unauthorized platform existence from unauthorized users.
     */
    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.getMembership(actor.userId, platformId);
        if (!membership) throw new NotFoundException('Platform not found.');
    }

    /**
     * Write access (Create / Edit / Archive): permitted to platform owner, global system admins, 
     * or platform members with the `ADMIN` role.
     * * @throws `ForbiddenException` if user lacks required permissions.
     */
    private async assertCanEdit(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        const membership = await this.getMembership(actor.userId, platformId);
        if (membership?.role === 'ADMIN') return platform;

        throw new ForbiddenException(
            'You must be the owner, a platform administrator, or possess the required permission.',
        );
    }

    /**
     * Hard Delete access: restricted EXCLUSIVELY to platform owners or global system admins.
     * Platform `ADMIN` members cannot hard delete even if they have `field.delete` permission; 
     * they must archive instead.
     * * @throws `ForbiddenException` if actor is not the owner or global admin.
     */
    private async assertCanDelete(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        throw new ForbiddenException(
            'Only the platform owner can perform permanent deletions. You can archive the field instead.',
        );
    }

    /**
     * Helper: Generates a unique, SQL-safe column name for an entity by appending numeric suffixes 
     * (`_2`, `_3`, etc.) if a duplicate column identifier is detected within the same entity scope.
     */
    private async generateUniqueColumn(entityId: string, name: string): Promise<string> {
        const base = toSqlIdentifier(name, 'field');
        let candidate = base;
        let counter = 2;
        
        while (
            await this.prisma.field.findUnique({ where: { entityId_column: { entityId, column: candidate } } })
        ) {
            candidate = `${base}_${counter}`;
            counter++;
        }
        return candidate;
    }
}