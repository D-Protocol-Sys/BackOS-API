import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { RelationsService } from './relations.service';
import { CreateRelationDto } from './dto/create-relation.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * Type defining the requesting user (actor) details, including ID and global permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * REST Controller providing HTTP endpoints for managing entity relationships
 * (e.g., ONE_TO_MANY, MANY_TO_MANY) scoped within a specific platform.
 */
@ApiTags('Relations')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/relations')
export class RelationsController {
    
    constructor(private readonly relationsService: RelationsService) {}

    /**
     * Lists all entity relations configured for a specific platform.
     * * @route GET /platforms/:platformId/relations
     */
    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.relationsService.list(actor, platformId);
    }

    /**
     * Creates a new relation mapping between two entities in the platform.
     * * @route POST /platforms/:platformId/relations
     */
    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: CreateRelationDto,
    ) {
        return this.relationsService.create(actor, platformId, dto);
    }

    /**
     * Deletes an existing relation from the platform by its unique ID.
     * * @route DELETE /platforms/:platformId/relations/:relationId
     */
    @Delete(':relationId')
    delete(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('relationId') relationId: string,
    ) {
        return this.relationsService.delete(actor, platformId, relationId);
    }
}