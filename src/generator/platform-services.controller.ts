import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { PlatformServicesService } from './platform-services.service';
import { EnableServiceDto } from './dto/enable-service.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

type Actor = { userId: string; permissions: string[] };

@ApiTags('Service Catalog')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/services')
export class PlatformServicesController {

    constructor(private readonly platformServices: PlatformServicesService) {}

    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.platformServices.list(actor, platformId);
    }

    @Post()
    enable(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: EnableServiceDto,
    ) {
        return this.platformServices.enable(actor, platformId, dto.serviceKey, dto.config);
    }

    @Delete(':serviceKey')
    disable(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('serviceKey') serviceKey: string,
    ) {
        return this.platformServices.disable(actor, platformId, serviceKey);
    }
    
}