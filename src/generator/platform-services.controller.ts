import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { PlatformServicesService } from './platform-services.service';
import { EnableServiceDto } from './dto/enable-service.dto';
import { SetProfileFieldsDto } from './dto/set-profile-fields.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

/**
 * Type representing the authenticated user context (actor) managing platform services.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * REST Controller exposing management endpoints for platform-level services.
 * Allows users to list, enable, and disable modular services associated with a specific platform.
 */
@ApiTags('Service Catalog')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/services')
export class PlatformServicesController {
    constructor(private readonly platformServices: PlatformServicesService) {}

    /**
     * Lists all available and currently enabled services for a target platform.
     * Delegates authorization and listing logic to the underlying service layer.
     *
     * @param actor - The authenticated user making the request.
     * @param platformId - Unique identifier of the target platform.
     */
    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.platformServices.list(actor, platformId);
    }

    /**
     * Enables and configures a specific service for the designated platform.
     * Accepts a payload containing the service key and optional dynamic configuration parameters.
     *
     * @param actor - The authenticated user making the request.
     * @param platformId - Unique identifier of the target platform.
     * @param dto - Data transfer object containing the serviceKey and configuration options.
     */
    @Post()
    enable(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Body() dto: EnableServiceDto) {
        return this.platformServices.enable(actor, platformId, dto.serviceKey, dto.config);
    }

    /**
     * Returns the profile fields external users must/can fill in after signing up to the
     * platform's generated backend (Auth & User service, with external users enabled).
     *
     * @param actor - The authenticated user making the request.
     * @param platformId - Unique identifier of the target platform.
     */
    @Get('auth-user/profile-fields')
    getProfileFields(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.platformServices.getProfileFields(actor, platformId);
    }

    /**
     * Defines (replaces) the profile fields of external users. Second step after enabling
     * Auth & User with `allowExternalUsers: true`; takes effect at the next generation.
     *
     * @param actor - The authenticated user making the request.
     * @param platformId - Unique identifier of the target platform.
     * @param dto - The full list of profile fields.
     */
    @Put('auth-user/profile-fields')
    setProfileFields(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: SetProfileFieldsDto,
    ) {
        return this.platformServices.setProfileFields(actor, platformId, dto);
    }

    /**
     * Disables and removes an active service integration from the platform.
     *
     * @param actor - The authenticated user making the request.
     * @param platformId - Unique identifier of the target platform.
     * @param serviceKey - Unique key identifier of the service to disable.
     */
    @Delete(':serviceKey')
    disable(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('serviceKey') serviceKey: string,
    ) {
        return this.platformServices.disable(actor, platformId, serviceKey);
    }
}
