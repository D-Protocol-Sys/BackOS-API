import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { FieldsService } from './fields.service';
import { CreateFieldDto } from './dto/create-field.dto';
import { UpdateFieldDto } from './dto/update-field.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Actor = { userId: string; permissions: string[] };

@Controller('platforms/:platformId/entities/:entityId/fields')
export class FieldsController {
    
    constructor(private readonly fieldsService: FieldsService) {}

    @Get()
    list(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
    ) {
        return this.fieldsService.list(actor, platformId, entityId);
    }

    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Body() dto: CreateFieldDto,
    ) {
        return this.fieldsService.create(actor, platformId, entityId, dto);
    }

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

    @Delete(':fieldId')
    delete(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Param('fieldId') fieldId: string,
    ) {
        return this.fieldsService.delete(actor, platformId, entityId, fieldId);
    }

    @Patch(':fieldId/archive')
    archive(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('entityId') entityId: string,
        @Param('fieldId') fieldId: string,
    ) {
        return this.fieldsService.archive(actor, platformId, entityId, fieldId);
    }

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