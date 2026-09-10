import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { CreatePlanningEntryDto } from './dto/create-planning-entry.dto';
import { UpdatePlanningEntryDto } from './dto/update-planning-entry.dto';
import { AddAssigneeDto } from './dto/add-assignee.dto';
import { ReassignResponsibleDto } from './dto/reassign-responsible.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

/**
 * Type representing the authenticated user performing the action.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Controller handling platform-scoped planning entries and assignee management.
 * Leverages OpenAPI (Swagger) decorators for API documentation and security scheme annotations.
 * * Base Route: `/platforms/:platformId/planning`
 */
@ApiTags('Platforms Planning')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/planning')
export class PlatformPlanningController {
    constructor(private readonly planningService: PlanningService) {}

    /**
     * Creates a new planning entry under a specific platform context.
     * * @param actor - The authenticated user issuing the request.
     * @param platformId - Unique ID of the parent platform passed in route parameters.
     * @param dto - Validated input data payload.
     */
    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: CreatePlanningEntryDto,
    ) {
        return this.planningService.createPlatformEntry(actor, platformId, dto);
    }

    /**
     * Retrieves all planning entries associated with a specific platform.
     * Parses the string query parameter into a boolean flag for user-specific filtering.
     * * @param actor - The requesting user context.
     * @param platformId - Target platform ID from URL parameters.
     * @param assignedToMe - Optional string query flag ('true'/'false') to filter assigned items.
     */
    @Get()
    list(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Query('assignedToMe') assignedToMe?: string,
    ) {
        // Coerce the optional query string to a boolean value expected by the service layer
        return this.planningService.listPlatformEntries(actor, platformId, assignedToMe === 'true');
    }

    /**
     * COMPLETENESS FIX: read-side counterpart to `reassignResponsible()` below - returns who
     * is currently responsible for this platform's planning (or `null` if unset), so a client
     * can display that before offering to change it. See `PlanningService.getResponsible()`.
     * * @route GET /platforms/:platformId/planning/responsible
     */
    @Get('responsible')
    getResponsible(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.planningService.getResponsible(actor, platformId);
    }

    /**
     * SECURITY FIX (audit #1/#5 follow-up): reassigns the platform planning's "responsible"
     * user to someone else. See `PlanningService.reassignResponsible()` for the full rationale -
     * this is what lets an admin resolve `UsersService.hardDeleteUser()`'s pre-check when the
     * account being deleted is still a planning's responsible party.
     *
     * IMPORTANT: this literal route MUST be registered before `@Patch(':id')` below - Nest
     * (via Express) matches routes in registration order, so if `:id` came first, a request to
     * `.../planning/responsible` would incorrectly be captured by `update()` with `id`
     * literally set to the string `"responsible"`.
     * * @route PATCH /platforms/:platformId/planning/responsible
     */
    @Patch('responsible')
    reassignResponsible(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: ReassignResponsibleDto,
    ) {
        return this.planningService.reassignResponsible(actor, platformId, dto);
    }

    /**
     * Updates an existing platform planning entry using partial payload semantics (PATCH).
     * * @param actor - Requesting actor context.
     * @param platformId - ID of parent platform.
     * @param id - ID of target planning entry.
     * @param dto - Validated update fields payload.
     */
    @Patch(':id')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Body() dto: UpdatePlanningEntryDto,
    ) {
        return this.planningService.updatePlatformEntry(actor, platformId, id, dto);
    }

    /**
     * Removes a planning entry from the specified platform context.
     * * @param actor - Requesting user context.
     * @param platformId - Target platform ID.
     * @param id - Entry ID targeted for deletion.
     */
    @Delete(':id')
    delete(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('id') id: string) {
        return this.planningService.deletePlatformEntry(actor, platformId, id);
    }

    /**
     * Assigns a team member to a specific platform planning entry.
     * Nested sub-resource route: `/platforms/:platformId/planning/:id/assignees`
     * * @param actor - Requesting user context.
     * @param platformId - Target platform ID.
     * @param id - Target planning entry ID.
     * @param dto - Payload containing the target user's ID to be assigned.
     */
    @Post(':id/assignees')
    addAssignee(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Body() dto: AddAssigneeDto,
    ) {
        return this.planningService.addAssignee(actor, platformId, id, dto.userId);
    }

    /**
     * Removes an assigned team member from a platform planning entry.
     * * @param actor - Requesting user context.
     * @param platformId - Target platform ID.
     * @param id - Target planning entry ID.
     * @param userId - ID of the user to unassign from the entry.
     */
    @Delete(':id/assignees/:userId')
    removeAssignee(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Param('userId') userId: string,
    ) {
        return this.planningService.removeAssignee(actor, platformId, id, userId);
    }
}