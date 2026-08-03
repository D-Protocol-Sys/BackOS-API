import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { EntitiesService } from './entities.service';
import { CreateEntityDto } from './dto/create-entity.dto';
import { UpdateEntityDto } from './dto/update-entity.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Actor = { userId: string; permissions: string[] };

@Controller('platforms/:platformId/entities')
export class EntitiesController {
    
    constructor(private readonly entitiesService: EntitiesService) {}

    @Get()
    list(
        @CurrentUser() actor: Actor, 
        @Param('platformId') platformId: string,
        @Query('includeArchived') includeArchived?: string
    ) {
        return this.entitiesService.list(actor, platformId, includeArchived === 'true');
    }

    @Get(':entityId')
    getById(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
    ) {
        return this.entitiesService.getById(actor, platformId, entityId);
    }

    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: CreateEntityDto,
    ) {
        return this.entitiesService.create(actor, platformId, dto);
    }

    @Patch(':entityId')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Body() dto: UpdateEntityDto,
    ) {
        return this.entitiesService.update(actor, platformId, entityId, dto);
    }

    @Delete(':entityId')
    delete(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
    ) {
        return this.entitiesService.delete(actor, platformId, entityId);
    }

    @Patch(':entityId/archive')
    archive(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
    ) {
        return this.entitiesService.archive(actor, platformId, entityId);
    }

    @Patch(':entityId/restore')
    restore(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
    ) {
        return this.entitiesService.restore(actor, platformId, entityId);
    }

}
