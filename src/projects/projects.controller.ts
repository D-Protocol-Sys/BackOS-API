import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { ProjectStatus } from '@prismamodels/client';

/**
 * Type defining the requesting user (actor) details, including ID and global permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * REST Controller providing HTTP endpoints for managing projects - product/feature ideas
 * someone intends to build and sell, optionally linked to a Platform (generated backend).
 *
 * NOTE ON GUARDS: `JwtAuthGuard` and `PermissionsGuard` are registered globally in
 * `AppModule`, so every route below is authenticated and permission-checked without needing
 * `@UseGuards(...)` here - `@RequirePermissions(...)` alone is enough.
 */
@ApiTags('Projects')
@ApiBearerAuth('access-token')
@Controller('projects')
export class ProjectsController {

    constructor(private readonly projectsService: ProjectsService) {}

    /**
     * Creates a new project.
     * Requires global `PROJECT_CREATE` permission. The creating user becomes the manager
     * unless a different `managerId` is supplied in the body.
     * * @route POST /projects
     */
    @RequirePermissions(PERMISSIONS.PROJECT_CREATE)
    @Post()
    create(@CurrentUser() actor: Actor, @Body() dto: CreateProjectDto) {
        return this.projectsService.create(actor, dto);
    }

    /**
     * Lists projects visible to the current user (every project for global readers, only
     * managed projects otherwise). Optionally filters by platform and/or status.
     * * @route GET /projects
     */
    @Get()
    list(
        @CurrentUser() actor: Actor,
        @Query('platformId') platformId?: string,
        @Query('status') status?: ProjectStatus,
    ) {
        return this.projectsService.list(actor, { platformId, status });
    }

    /**
     * Retrieves detailed information about a specific project by ID.
     * * @route GET /projects/:id
     */
    @Get(':id')
    getById(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.projectsService.getById(actor, id);
    }

    /**
     * Updates project properties (e.g. name, description, status, dates, manager, platform link).
     * * @route PATCH /projects/:id
     */
    @Patch(':id')
    update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdateProjectDto) {
        return this.projectsService.update(actor, id, dto);
    }

    /**
     * Permanently deletes a project.
     * * @route DELETE /projects/:id
     */
    @Delete(':id')
    remove(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.projectsService.delete(actor, id);
    }

}
