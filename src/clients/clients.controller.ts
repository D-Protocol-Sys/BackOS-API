import { Controller, Get, Post, Body, Patch, Param, Delete, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery, ApiParam, ApiBody } from '@nestjs/swagger';
import { ClientsService } from './clients.service';
import { CreateClientDto } from './dto/create-client.dto';
import { UpdateClientDto } from './dto/update-client.dto';
import { SubmitTestimonialDto } from './dto/submit-testimonial.dto';
import { CreateContractDto } from './dto/create-contract.dto';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';

/*
 * NOTE ON GUARDS: `JwtAuthGuard` and `PermissionsGuard` are both registered globally in
 * `AppModule` via `APP_GUARD`, so every route in this application is protected by default
 * without needing `@UseGuards(...)` on each controller/handler. The previous version of this
 * file re-declared `@UseGuards(PermissionsGuard)` on every protected route, which was
 * redundant (harmless, but confusing - it could wrongly suggest that controllers WITHOUT
 * that decorator are unprotected, which is not the case). It has been removed below; the
 * `@RequirePermissions(...)` decorator alone is sufficient, since the global guard reads it.
 */

/**
 * Controller managing HTTP requests for client management, testimonials, and contracts.
 * Utilizes OpenAPI decorators to generate dynamic REST documentation.
 */
@ApiTags('Clients')
@ApiBearerAuth('access-token')
@Controller('clients')
export class ClientsController {

    constructor(private readonly clientsService: ClientsService) {}

    // ==========================================
    // --- PUBLIC ENDPOINTS (UNPROTECTED) ---
    // ==========================================

    /**
     * Fetches all approved testimonials intended for public display.
     *
     * BUG FIX: this route is meant to be reachable by anonymous website visitors (it powers
     * a public testimonials page), but it was missing the `@Public()` decorator. Since
     * `JwtAuthGuard` is registered globally and only skips authentication for routes carrying
     * `@Public()` metadata, this endpoint previously required a valid Bearer token despite the
     * "PUBLIC ENDPOINTS" section header - effectively making the feature unusable for its
     * intended anonymous audience.
     */
    // SECURITY FIX (SEC-028): anonymous routes are rate-limited per IP.
    @Throttle({ default: { limit: 60, ttl: 60_000 } })
    @UseGuards(ThrottlerGuard)
    @Public()
    @Get('public/testimonials')
    @ApiOperation({
        summary: 'Get public testimonials',
        description: 'Retrieves a list of all client testimonials flagged for public view.',
    })
    @ApiResponse({
        status: 200,
        description: 'Public testimonials retrieved successfully.',
    })
    getPublicTestimonials() {
        return this.clientsService.getPublicTestimonials();
    }

    /**
     * Submits a testimonial using a single-use token sent to the client.
     *
     * BUG FIX: same issue as `getPublicTestimonials()` above - a client who received an
     * invitation e-mail is NOT an authenticated platform user and has no Bearer token to
     * present. `@Public()` is required for this token-based flow to work at all. Access
     * control for this endpoint is instead enforced by the token itself, which is generated
     * with 256 bits of entropy, stored as a SHA-256 hash (see `ClientsService`), single-use,
     * and time-limited to 7 days.
     */
    // SECURITY FIX (SEC-028): token-guessing / spam protection on the anonymous submit route.
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @UseGuards(ThrottlerGuard)
    @Public()
    @Post('public/submit-testimonial')
    @ApiOperation({
        summary: 'Submit client testimonial by token',
        description: 'Allows clients to submit feedback using a valid token link received via email.',
    })
    @ApiQuery({
        name: 'token',
        required: true,
        description: 'The unique single-use validation token.',
        type: String,
    })
    @ApiResponse({
        status: 200,
        description: 'Testimonial successfully recorded.',
    })
    @ApiResponse({
        status: 400,
        description: 'Missing validation token.',
    })
    @ApiResponse({
        status: 404,
        description: 'Invalid or expired token.',
    })
    submitByToken(
        @Query('token') token: string,
        @Body() dto: SubmitTestimonialDto,
    ) {
        return this.clientsService.submitTestimonialByToken(token, dto);
    }

    // ==========================================
    // --- PROTECTED ADMINISTRATIVE ENDPOINTS ---
    // ==========================================

    /**
     * Creates a new client record.
     * Requires JWT Bearer Authentication and CLIENT_CREATE permission.
     */
    @Post()
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_CREATE)
    @ApiOperation({
        summary: 'Create a new client',
        description: 'Creates a client record and writes an entry to the audit log.',
    })
    @ApiResponse({
        status: 201,
        description: 'Client successfully created.',
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized access token.',
    })
    @ApiResponse({
        status: 403,
        description: 'Forbidden: Insufficient permissions.',
    })
    @ApiResponse({
        status: 409,
        description: 'Conflict: Email already exists.',
    })
    create(
        @Body() dto: CreateClientDto,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.create(dto, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Retrieves a paginated list of all clients.
     */
    @Get()
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_READ)
    @ApiOperation({
        summary: 'List all clients',
        description: 'Fetches paginated clients with optional status filter.',
    })
    @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
    @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
    @ApiQuery({ name: 'status', required: false, type: String })
    @ApiQuery({ name: 'includeArchived', required: false, type: Boolean, description: 'Include archived clients (excluded by default)' })
    @ApiResponse({
        status: 200,
        description: 'Paginated client list retrieved successfully.',
    })
    @ApiResponse({
        status: 401,
        description: 'Unauthorized access token.',
    })
    @ApiResponse({
        status: 403,
        description: 'Forbidden: Insufficient permissions.',
    })
    findAll(
        @Query('page') page?: number,
        @Query('limit') limit?: number,
        @Query('status') status?: string,
        @Query('includeArchived') includeArchived?: string,
    ) {
        return this.clientsService.findAll(page, limit, status, includeArchived === 'true');
    }

    /**
     * Retrieves paginated clients associated with a specific platform.
     */
    @Get('platform/:platformId')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_READ)
    @ApiOperation({
        summary: 'Get clients by platform ID',
        description: 'Retrieves clients belonging to a given platform.',
    })
    @ApiParam({ name: 'platformId', description: 'Unique identifier of the platform' })
    @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
    @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
    @ApiResponse({
        status: 200,
        description: 'Clients retrieved successfully.',
    })
    findByPlatform(
        @Param('platformId') platformId: string,
        @Query('page') page?: number,
        @Query('limit') limit?: number,
        @Query('includeArchived') includeArchived?: string,
    ) {
        return this.clientsService.findByPlatform(platformId, page, limit, includeArchived === 'true');
    }

    /**
     * Retrieves full details for a single client by ID.
     */
    @Get(':id')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_READ)
    @ApiOperation({
        summary: 'Get client by ID',
        description: 'Fetches a single client along with linked platform and contracts data.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 200,
        description: 'Client details retrieved successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    findOne(@Param('id') id: string) {
        return this.clientsService.findOne(id);
    }

    /**
     * Updates an existing client record.
     */
    @Patch(':id')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_UPDATE)
    @ApiOperation({
        summary: 'Update a client',
        description: 'Updates client fields and logs changes in the audit history.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 200,
        description: 'Client updated successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    update(
        @Param('id') id: string,
        @Body() dto: UpdateClientDto,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.update(id, dto, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Archives a client (soft delete): starts a retention countdown after which it (and every
     * one of its contracts, with their attached files) is permanently deleted automatically -
     * see `docs/README.md` §5 (mirrors the exact same lifecycle already in place for
     * platforms). Reversible via `PATCH /clients/:id/restore` at any point before that window
     * elapses.
     */
    @Delete(':id')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_DELETE)
    @ApiOperation({
        summary: 'Archive a client',
        description: 'Archives a client and starts its permanent-deletion countdown. Reversible via restore.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 200,
        description: 'Client archived successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    remove(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.archive(id, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Restores an archived client, cancelling its pending permanent deletion.
     */
    @Patch(':id/restore')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_DELETE)
    @ApiOperation({
        summary: 'Restore an archived client',
        description: 'Restores an archived client back to ACTIVE and cancels its pending deletion.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 200,
        description: 'Client restored successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    restore(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.restore(id, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Immediately and irreversibly deletes an already-archived client, without waiting for its
     * retention window to elapse - along with every one of its contracts and their attached
     * files. Requires the client to be ARCHIVED first (see `remove()` above).
     */
    @Delete(':id/permanent')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_DELETE)
    @ApiOperation({
        summary: 'Permanently delete a client',
        description: 'Immediately and irreversibly deletes an already-archived client, its contracts, and their files.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 200,
        description: 'Client permanently deleted.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    purge(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.purge(id, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    // ==========================================
    // --- ADMIN TESTIMONIAL MANAGEMENT ---
    // ==========================================

    /**
     * Generates a 7-day valid invitation token for a client review submission.
     */
    @Post(':id/testimonial-invite')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_UPDATE)
    @ApiOperation({
        summary: 'Generate testimonial invite link',
        description: 'Creates a temporary single-use token to invite client feedback.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 201,
        description: 'Testimonial invite generated successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    generateInvite(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.generateTestimonialInvite(id, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Toggles whether a client testimonial is published on public routes.
     */
    @Patch(':id/testimonial/toggle-visibility')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CLIENT_MANAGE_TESTIMONIALS)
    @ApiOperation({
        summary: 'Toggle testimonial visibility',
        description: 'Approve or revoke public access for a client testimonial.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiBody({
        schema: {
        type: 'object',
        properties: {
            isPublic: { type: 'boolean', example: true },
        },
        },
    })
    @ApiResponse({
        status: 200,
        description: 'Testimonial visibility updated successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    toggleTestimonial(
        @Param('id') id: string,
        @Body('isPublic') isPublic: boolean,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.toggleTestimonialVisibility(id, isPublic, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }

    // ==========================================
    // --- CONTRACT MANAGEMENT ---
    // ==========================================

    /**
     * Creates a contract attached to a specific client.
     */
    @Post(':id/contracts')
    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.CONTRACT_CREATE)
    @ApiOperation({
        summary: 'Add contract to client',
        description: 'Creates a new contract record linked to the client ID.',
    })
    @ApiParam({ name: 'id', description: 'Client unique identifier' })
    @ApiResponse({
        status: 201,
        description: 'Contract attached successfully.',
    })
    @ApiResponse({
        status: 404,
        description: 'Client not found.',
    })
    addContract(
        @Param('id') clientId: string,
        @Body() dto: CreateContractDto,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.addContract(clientId, dto, userId, {
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        });
    }
}