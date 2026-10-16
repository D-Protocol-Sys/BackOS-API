import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EntitiesService } from './entities.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * Type definition representing the requesting actor (authenticated user context and global permissions).
 */
type Actor = { userId: string; permissions: string[] };

/**
 * NestJS Controller handling HTTP REST endpoints for Platform Entities management.
 * Base route scoped to a specific platform: `/platforms/:platformId/entities`
 */
@ApiTags('Entities')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/entities')
export class EntitiesController {
    /**
     * @param entitiesService - Service injected to encapsulate domain and database business logic.
     */
    constructor(private readonly entitiesService: EntitiesService) {}

    /**
     * Retrieves all dynamic entities associated with a specific platform.
     * * @route GET `/platforms/:platformId/entities`
     * @param actor - Populated automatically via `@CurrentUser()` custom decorator.
     * @param platformId - Extracted route parameter identifying the parent platform.
     * @param includeArchived - Optional query parameter (`?includeArchived=true`) to include soft-deleted records.
     */
    @Get()
    list(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Query('includeArchived') includeArchived?: string,
    ) {
        // Converts query string representation to a strict boolean value
        return this.entitiesService.list(actor, platformId, includeArchived === 'true');
    }

    /**
     * Retrieves a single entity by its unique ID within a platform scope.
     * * @route GET `/platforms/:platformId/entities/:entityId`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     */
    @Get(':entityId')
    getById(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('entityId') entityId: string) {
        return this.entitiesService.getById(actor, platformId, entityId);
    }

    /**
     * Creates a new dynamic entity under the specified platform.
     * * @route POST `/platforms/:platformId/entities`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param dto - Validated body payload mapped to `CreateEntityDto`.
     */
    @Post()
    create(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Body() dto: CreateEntityDto) {
        return this.entitiesService.create(actor, platformId, dto);
    }

    /**
     * Updates an existing entity's properties (e.g., entity name).
     * * @route PATCH `/platforms/:platformId/entities/:entityId`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     * @param dto - Validated body payload mapped to `UpdateEntityDto`.
     */
    @Patch(':entityId')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Body() dto: UpdateEntityDto,
    ) {
        return this.entitiesService.update(actor, platformId, entityId, dto);
    }

    /**
     * Permanently deletes an entity record from the database.
     * * @route DELETE `/platforms/:platformId/entities/:entityId`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     */
    @Delete(':entityId')
    delete(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('entityId') entityId: string) {
        return this.entitiesService.delete(actor, platformId, entityId);
    }

    /**
     * Toggles cron job or automated scheduling capabilities for an entity.
     * * @route PATCH `/platforms/:platformId/entities/:entityId/schedulable`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     * @param enabled - Extracted property `enabled` from request JSON body (`{ "enabled": true }`).
     */
    @Patch(':entityId/schedulable')
    setSchedulable(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Body('enabled') enabled: boolean,
    ) {
        return this.entitiesService.setSchedulable(actor, platformId, entityId, enabled);
    }

    /**
     * Soft-deletes an entity by marking its status as archived.
     * * @route PATCH `/platforms/:platformId/entities/:entityId/archive`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     */
    @Patch(':entityId/archive')
    archive(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('entityId') entityId: string) {
        return this.entitiesService.archive(actor, platformId, entityId);
    }

    /**
     * Restores an archived entity back to active status.
     * * @route PATCH `/platforms/:platformId/entities/:entityId/restore`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     */
    @Patch(':entityId/restore')
    restore(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('entityId') entityId: string) {
        return this.entitiesService.restore(actor, platformId, entityId);
    }

    /**
     * Configures route-level authentication requirements for CRUD operations on an entity.
     * * @route PATCH `/platforms/:platformId/entities/:entityId/auth-protection`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Target entity ID.
     * @param flags - Object containing boolean flags for endpoint protection (`create`, `read`, `update`, `delete`).
     */
    @Patch(':entityId/auth-protection')
    setAuthProtection(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Body() flags: { create?: boolean; read?: boolean; update?: boolean; delete?: boolean },
    ) {
        return this.entitiesService.setAuthProtection(actor, platformId, entityId, flags);
    }
}
