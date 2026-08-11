import {
    Injectable, NotFoundException, ForbiddenException, BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { toSqlIdentifier } from '../common/utils/sql-identifier.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';

/**
 * Type definition representing the requesting actor (user context and global permissions).
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Service managing platform dynamic entities (CRUD operations, access control, 
 * table name generation, and feature flags like schedulable or auth protection).
 */
@Injectable()
export class EntitiesService {

    /**
     * @param prisma - Database client providing access to Prisma ORM methods.
     */
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Retrieves all dynamic entities associated with a specific platform.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param includeArchived - Optional flag to include archived entities in the result set.
     * @returns Array of entity records with their associated fields ordered by display position.
     */
    async list(actor: Actor, platformId: string, includeArchived = false) {
        await this.assertCanView(actor, platformId);
        
        return this.prisma.entity.findMany({
            where: { platformId, ...(includeArchived ? {} : { isArchived: false }) },
            include: { fields: { orderBy: { order: 'asc' } } },
            orderBy: { createdAt: 'asc' },
        });
    }

    /**
     * Fetches a single dynamic entity by its ID within a platform.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @returns The entity record with ordered child fields.
     */
    async getById(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanView(actor, platformId);
        const entity = await this.findEntityOrThrow(platformId, entityId);
        
        return this.prisma.entity.findUnique({
            where: { id: entity.id },
            include: { fields: { orderBy: { order: 'asc' } } },
        });
    }

    /**
     * Creates a new dynamic entity and automatically derives a collision-free SQL table name.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param dto - Data transfer object holding entity creation properties.
     * @returns The newly created entity record.
     */
    async create(actor: Actor, platformId: string, dto: CreateEntityDto) {
        const platform = await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_CREATE);
        // Generates a sanitized SQL table name (e.g., "user_profiles") with index appending if duplicated
        const tableName = await this.generateUniqueTableName(platformId, dto.name);

        return this.prisma.entity.create({
            data: { name: dto.name, tableName, platformId: platform.id },
        });
    }

    /**
     * Renames an existing dynamic entity.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @param dto - Partial payload containing the updated name.
     * @returns The updated entity record.
     */
    async update(actor: Actor, platformId: string, entityId: string, dto: UpdateEntityDto) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        return this.prisma.entity.update({ 
            where: { id: entity.id }, 
            data: { name: dto.name },
        });
    }

    /**
     * Enables or disables cron scheduling capabilities for an entity.
     * Requires the platform to have the 'scheduler' service enabled beforehand.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @param enabled - True to enable scheduling capabilities; false to disable.
     * @throws `BadRequestException` if scheduling is turned on without the prerequisite platform service.
     */
    async setSchedulable(actor: Actor, platformId: string, entityId: string, enabled: boolean) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        if (enabled) {
            // Verifies if the required platform service feature is active
            const schedulerActive = await this.prisma.platformService.findUnique({
                where: { platformId_serviceKey: { platformId, serviceKey: 'scheduler' } },
            });
            if (!schedulerActive) {
                throw new BadRequestException(
                    'The "Scheduler" service must be enabled on this platform before making an entity schedulable.',
                );
            }
        }

        return this.prisma.entity.update({ 
            where: { id: entity.id }, 
            data: { isSchedulable: enabled },
        });
    }

    /**
     * Soft-deletes an entity by marking its `isArchived` flag as true.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @throws `BadRequestException` if the entity is already archived.
     */
    async archive(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_DELETE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        if (entity.isArchived) throw new BadRequestException('This entity is already archived.');
        
        return this.prisma.entity.update({ where: { id: entity.id }, data: { isArchived: true } });
    }

    /**
     * Restores a previously soft-deleted/archived entity back to active status.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @throws `BadRequestException` if the entity is not archived.
     */
    async restore(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_DELETE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        if (!entity.isArchived) throw new BadRequestException('This entity is not archived.');
        
        return this.prisma.entity.update({ where: { id: entity.id }, data: { isArchived: false } });
    }

    /**
     * Permanently deletes an entity record from the database. Restricted strictly to platform owners or superadmins.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @returns Success payload confirmation.
     */
    async delete(actor: Actor, platformId: string, entityId: string) {
        await this.assertCanDelete(actor, platformId, PERMISSIONS.ENTITY_DELETE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        await this.prisma.entity.delete({ where: { id: entity.id } });
        return { message: 'Entity permanently deleted.' };
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
     * Helper: Finds an entity matching both its unique ID and parent platform ID.
     */
    private async findEntityOrThrow(platformId: string, entityId: string) {
        const entity = await this.prisma.entity.findFirst({ where: { id: entityId, platformId } });
        if (!entity) throw new NotFoundException('Entity not found.');
        return entity;
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
     * Helper: Asserts read authorization based on ownership, global permission, or membership status.
     * * @throws `NotFoundException` masking unauthorized status to prevent resource enumeration attacks.
     */
    private async assertCanView(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;

        const membership = await this.getMembership(actor.userId, platformId);
        if (!membership) throw new NotFoundException('Platform not found.');
    }

    /**
     * Helper: Asserts edit authorization based on ownership, global permissions, or ADMIN membership role.
     * * @throws `ForbiddenException` if the actor lacks required administrative privileges.
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
     * Helper: Asserts permanent deletion authorization. Restricted strictly to platform owners or superadmins.
     * * @throws `ForbiddenException` if standard admins attempt to permanently destroy resources.
     */
    private async assertCanDelete(actor: Actor, platformId: string, permission: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        if (platform.ownerId === actor.userId) return platform;
        if (actor.permissions.includes(permission)) return platform;

        throw new ForbiddenException(
            'Only the platform owner can perform permanent deletions. You can archive the entity instead.',
        );
    }

    /**
     * Helper: Generates a unique, SQL-safe database table name by appending numeric suffixes 
     * (`_2`, `_3`, etc.) upon detecting existing name collisions within the same platform scope.
     */
    private async generateUniqueTableName(platformId: string, name: string): Promise<string> {
        const base = toSqlIdentifier(name, 'entity');
        let candidate = base;
        let counter = 2;
        
        // Loop terminates when a unique table name candidate is found in the database index
        while (
            await this.prisma.entity.findUnique({ 
                where: { platformId_tableName: { platformId, tableName: candidate } }, 
            })
        ) {
            candidate = `${base}_${counter}`;
            counter++;
        }
        return candidate;
    }

    /**
     * Configures route-level authentication protection flags on dynamic entities (Create, Read, Update, Delete).
     * Enforces prerequisite check requiring the 'auth-user' platform service to be active.
     * * @param actor - The current user performing the request.
     * @param platformId - Target platform ID.
     * @param entityId - Target entity ID.
     * @param flags - Configuration object specifying protection states for each HTTP verb action.
     */
    async setAuthProtection(
        actor: Actor,
        platformId: string,
        entityId: string,
        flags: { create?: boolean; read?: boolean; update?: boolean; delete?: boolean },
    ) {
        await this.assertCanEdit(actor, platformId, PERMISSIONS.ENTITY_UPDATE);
        const entity = await this.findEntityOrThrow(platformId, entityId);

        // Checks if at least one protection flag is set to true
        const anyProtectionRequested = Object.values(flags).some(Boolean);
        if (anyProtectionRequested) {
            const authUserActive = await this.prisma.platformService.findUnique({
                where: { platformId_serviceKey: { platformId, serviceKey: 'auth-user' } },
            });
            if (!authUserActive) {
                throw new BadRequestException(
                    'The "Auth & User" service must be enabled on this platform before protecting an entity.',
                );
            }
        }

        // Conditionally merges active flags into database update payload
        return this.prisma.entity.update({
            where: { id: entity.id },
            data: {
                ...(flags.create !== undefined && { authProtectCreate: flags.create }),
                ...(flags.read !== undefined && { authProtectRead: flags.read }),
                ...(flags.update !== undefined && { authProtectUpdate: flags.update }),
                ...(flags.delete !== undefined && { authProtectDelete: flags.delete }),
            },
        });
    }

}