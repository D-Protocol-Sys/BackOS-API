import { Body, Controller, Delete, Get, Param, Patch, Post, Query, ParseUUIDPipe } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { CreatePlanningEntryDto } from './dto/create-planning-entry.dto';
import { UpdatePlanningEntryDto } from './dto/update-planning-entry.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlanningItemType } from '@prismamodels/client';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/**
 * Interface representing the authenticated actor extracted from request context.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * NestJS Controller responsible for managing personal planning entries.
 * All endpoints under this controller operate strictly within the authenticated user's private context.
 */
@ApiTags('Personal Planning')
@ApiBearerAuth('access-token')
@Controller('planning/personal/entries')
export class PersonalPlanningController {
    constructor(private readonly planningService: PlanningService) {}

    /**
     * Creates a new personal planning entry for the authenticated actor.
     * * @param actor - Extracted user executing the request.
     * @param dto - Validated body payload containing planning entry details.
     */
    @Post()
    create(@CurrentUser() actor: Actor, @Body() dto: CreatePlanningEntryDto) {
        return this.planningService.createPersonal(actor, dto);
    }

    /**
     * Lists all personal planning entries belonging to the authenticated actor.
     * Supports optional filtering by item type via query parameter.
     * * @param actor - Requesting user context.
     * @param type - Optional query filter for specific planning types (e.g., ?type=EVENT).
     */
    @Get()
    list(@CurrentUser() actor: Actor, @Query('type') type?: PlanningItemType) {
        return this.planningService.listPersonal(actor, type);
    }

    /**
     * Retrieves a specific personal planning entry by its unique identifier.
     * * @param actor - Requesting user context.
     * @param id - Unique database entry ID passed as a route path parameter.
     */
    @Get(':id')
    getById(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
        return this.planningService.getPersonalById(actor, id);
    }

    /**
     * Performs a partial update (PATCH) on an existing personal planning entry.
     * * @param actor - Requesting user context.
     * @param id - Unique entry ID to update.
     * @param dto - Validated update payload with optional fields to modify.
     */
    @Patch(':id')
    update(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanningEntryDto) {
        return this.planningService.updatePersonal(actor, id, dto);
    }

    /**
     * Deletes a personal planning entry by its unique ID.
     * * @param actor - Requesting user context.
     * @param id - Target entry ID for removal.
     */
    @Delete(':id')
    delete(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
        return this.planningService.deletePersonal(actor, id);
    }
}
