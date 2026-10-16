import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { FieldsService } from './fields.service';
import { CreateFieldDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * Type definition representing the requesting actor (authenticated user context and permissions).
 */
type Actor = { userId: string; permissions: string[] };

/**
 * NestJS Controller handling HTTP REST operations for entity field management.
 * Base route scoped hierarchically: `/platforms/:platformId/entities/:entityId/fields`
 */
@ApiTags('Fields')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/entities/:entityId/fields')
export class FieldsController {
    /**
     * @param fieldsService - Injected service handling domain logic and database operations for fields.
     */
    constructor(private readonly fieldsService: FieldsService) {}

    /**
     * Lists all non-archived fields belonging to a target entity.
     * * @route GET `/platforms/:platformId/entities/:entityId/fields`
     * @param actor - Populated automatically via `@CurrentUser()` custom decorator.
     * @param platformId - Extracted platform context ID.
     * @param entityId - Extracted parent entity ID.
     */
    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('entityId') entityId: string) {
        return this.fieldsService.list(actor, platformId, entityId);
    }

    /**
     * Creates a new field under a specific dynamic entity.
     * * @route POST `/platforms/:platformId/entities/:entityId/fields`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Parent entity ID.
     * @param dto - Validated body payload mapped to `CreateFieldDto`.
     */
    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Body() dto: CreateFieldDto,
    ) {
        return this.fieldsService.create(actor, platformId, entityId, dto);
    }

    /**
     * Updates an existing field within an entity (e.g., label, constraints, or configurations).
     * * @route PATCH `/platforms/:platformId/entities/:entityId/fields/:fieldId`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     * @param dto - Validated partial body payload mapped to `UpdateFieldDto`.
     */
    @Patch(':fieldId')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Param('fieldId') fieldId: string,
        @Body() dto: UpdateFieldDto,
    ) {
        return this.fieldsService.update(actor, platformId, entityId, fieldId, dto);
    }

    /**
     * Permanently deletes a field record from the database (Platform Owners / Superadmins only).
     * * @route DELETE `/platforms/:platformId/entities/:entityId/fields/:fieldId`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     */
    @Delete(':fieldId')
    delete(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Param('fieldId') fieldId: string,
    ) {
        return this.fieldsService.delete(actor, platformId, entityId, fieldId);
    }

    /**
     * Soft-deletes a field by setting its status to archived.
     * * @route PATCH `/platforms/:platformId/entities/:entityId/fields/:fieldId/archive`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     */
    @Patch(':fieldId/archive')
    archive(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Param('fieldId') fieldId: string,
    ) {
        return this.fieldsService.archive(actor, platformId, entityId, fieldId);
    }

    /**
     * Restores an archived field back to active status.
     * * @route PATCH `/platforms/:platformId/entities/:entityId/fields/:fieldId/restore`
     * @param actor - Current authenticated user context.
     * @param platformId - Parent platform ID.
     * @param entityId - Parent entity ID.
     * @param fieldId - Target field ID.
     */
    @Patch(':fieldId/restore')
    restore(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Param('fieldId') fieldId: string,
    ) {
        return this.fieldsService.restore(actor, platformId, entityId, fieldId);
    }
}
