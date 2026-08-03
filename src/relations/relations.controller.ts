import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { RelationsService } from './relations.service';
import { CreateRelationDto } from './dto/create-relation.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

type Actor = { userId: string; permissions: string[] };

@ApiTags('Relations')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/relations')
export class RelationsController {
    
    constructor(private readonly relationsService: RelationsService) {}

    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.relationsService.list(actor, platformId);
    }

    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: CreateRelationDto,
    ) {
        return this.relationsService.create(actor, platformId, dto);
    }

    @Delete(':relationId')
    delete(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('relationId') relationId: string,
    ) {
        return this.relationsService.delete(actor, platformId, relationId);
    }
}