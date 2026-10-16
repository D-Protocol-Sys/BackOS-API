import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { EnumDefinitionsService } from './enum-definitions.service';
import { CreateEnumDefinitionDto } from './dto/create-enum-definition.dto';
import { UpdateEnumDefinitionDto } from './dto/update-enum-definition.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Actor = { userId: string; permissions: string[] };

/**
 * CRUD for a platform's reusable ENUM option sets. Every route is scoped to `platformId` and
 * authorized inside `EnumDefinitionsService` (same rule as `FieldsController`) rather than via
 * `@RequirePermissions`, since "can edit" here depends on platform membership/role, not a single
 * static permission - hence this controller is one of the manually-reviewed ones in
 * `route-permission-audit.spec.ts`.
 */
@ApiTags('Enum Definitions')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/enum-definitions')
export class EnumDefinitionsController {
    constructor(private readonly enumDefinitions: EnumDefinitionsService) {}

    @ApiOperation({ summary: "List a platform's enum definitions" })
    @ApiOkResponse({ description: 'Enum definitions retrieved successfully.' })
    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.enumDefinitions.list(actor, platformId);
    }

    @ApiOperation({ summary: 'Create an enum definition' })
    @ApiCreatedResponse({ description: 'Enum definition created successfully.' })
    @Post()
    create(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Body() dto: CreateEnumDefinitionDto) {
        return this.enumDefinitions.create(actor, platformId, dto);
    }

    @ApiOperation({ summary: 'Update an enum definition' })
    @ApiOkResponse({ description: 'Enum definition updated successfully.' })
    @Patch(':enumDefinitionId')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('enumDefinitionId') enumDefinitionId: string,
        @Body() dto: UpdateEnumDefinitionDto,
    ) {
        return this.enumDefinitions.update(actor, platformId, enumDefinitionId, dto);
    }

    @ApiOperation({ summary: 'Delete an enum definition' })
    @ApiOkResponse({ description: 'Enum definition deleted successfully.' })
    @Delete(':enumDefinitionId')
    delete(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('enumDefinitionId') enumDefinitionId: string,
    ) {
        return this.enumDefinitions.delete(actor, platformId, enumDefinitionId);
    }
}
