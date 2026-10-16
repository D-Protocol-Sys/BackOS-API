import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    ParseEnumPipe,
    ParseIntPipe,
    Patch,
    Post,
    Put,
    Query,
} from '@nestjs/common';
import { PlanningWeekDay } from '@prismamodels/client';
import { PlanningProgramService } from './planning-program.service';
import { CreatePlanningProgramDto } from './dto/create-planning-program.dto';
import { UpdatePlanningProgramDto } from './dto/update-planning-program.dto';
import { UpsertProgramWeekDto } from './dto/upsert-program-week.dto';
import { ReplaceProgramDayDto } from './dto/replace-program-day.dto';
import { ScheduleProgramDto } from './dto/schedule-program.dto';
import { ApplyProgramDto } from './dto/apply-program.dto';
import { GenerateProgramOccurrencesDto } from './dto/generate-program-occurrences.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

type Actor = { userId: string; permissions: string[] };

/**
 * Controller for recurring planning "programs" (templates) attached to a platform's planning.
 * Mirrors `PersonalPlanningProgramController` - see `PlanningProgramService` for the shared
 * behaviour. Access control follows the exact same rule as the platform's real planning
 * entries (`PlatformPlanningController`): owner, global `PLANNING_MANAGE`/`PLANNING_READ`, or
 * platform ADMIN membership for writes / any membership for reads.
 *
 * Base Route: `/platforms/:platformId/planning/programs`
 */
@ApiTags('Platforms Planning Programs')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId/planning/programs')
export class PlatformPlanningProgramController {
    constructor(private readonly programService: PlanningProgramService) {}

    /** Creates a new program under this platform's planning. */
    @Post()
    create(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() dto: CreatePlanningProgramDto,
    ) {
        return this.programService.createForPlatform(actor, platformId, dto);
    }

    /** Lists this platform's programs (summary - weeks are listed by index only). */
    @Get()
    list(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        return this.programService.listForPlatform(actor, platformId);
    }

    /** Retrieves a single program with its full week/day/entry tree. */
    @Get(':id')
    getById(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('id') id: string) {
        return this.programService.getProgramById(actor, id);
    }

    /** Updates a program's top-level fields (name, description, cycleWeeks, timezone). */
    @Patch(':id')
    update(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Body() dto: UpdatePlanningProgramDto,
    ) {
        return this.programService.updateProgram(actor, id, dto);
    }

    /** Deletes a program and its whole week/day/entry tree. */
    @Delete(':id')
    delete(@CurrentUser() actor: Actor, @Param('platformId') platformId: string, @Param('id') id: string) {
        return this.programService.deleteProgram(actor, id);
    }

    /**
     * Creates or fully replaces a week (all its days/entries) at the given index. Extends the
     * program's cycle automatically if `weekIndex` is new.
     */
    @Put(':id/weeks/:weekIndex')
    upsertWeek(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Param('weekIndex', ParseIntPipe) weekIndex: number,
        @Body() dto: UpsertProgramWeekDto,
    ) {
        return this.programService.upsertWeek(actor, id, weekIndex, dto);
    }

    /** Removes a whole week (and its days/entries) from the program's cycle. */
    @Delete(':id/weeks/:weekIndex')
    deleteWeek(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Param('weekIndex', ParseIntPipe) weekIndex: number,
    ) {
        return this.programService.deleteWeek(actor, id, weekIndex);
    }

    /** Replaces a single day's entries within an existing week. */
    @Put(':id/weeks/:weekIndex/days/:dayOfWeek')
    replaceDayEntries(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Param('weekIndex', ParseIntPipe) weekIndex: number,
        @Param('dayOfWeek', new ParseEnumPipe(PlanningWeekDay)) dayOfWeek: PlanningWeekDay,
        @Body() dto: ReplaceProgramDayDto,
    ) {
        return this.programService.replaceDayEntries(actor, id, weekIndex, dayOfWeek, dto);
    }

    /** Switches the program's activation mode (OFF / CONTINUOUS / SCHEDULED). */
    @Patch(':id/schedule')
    schedule(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Body() dto: ScheduleProgramDto,
    ) {
        return this.programService.schedule(actor, id, dto);
    }

    /** Read-only preview of what the program resolves to on a given real date. */
    @Get(':id/preview')
    preview(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Query('date') date: string,
    ) {
        return this.programService.previewForDate(actor, id, date);
    }

    /** Projects the program onto one specific real date in the target platform planning. */
    @Post(':id/apply')
    apply(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Body() dto: ApplyProgramDto,
    ) {
        return this.programService.applyToPlatformDate(actor, platformId, id, dto);
    }

    /** Bulk variant of `apply` over a date range. */
    @Post(':id/generate')
    generate(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('id') id: string,
        @Body() dto: GenerateProgramOccurrencesDto,
    ) {
        return this.programService.generateForPlatform(actor, platformId, id, dto);
    }
}
