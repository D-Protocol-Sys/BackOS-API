import {
    Body, Controller, Delete, Get, Param, ParseEnumPipe, ParseIntPipe, Patch, Post, Put, Query,
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
 * Controller for recurring planning "programs" (templates - e.g. "Sport", "Cours") attached to
 * the authenticated actor's own personal planning. See `PlanningProgramService` for the full
 * behaviour: the week/day/entry tree, the schedule/active state machine, and projection onto
 * the real dated planning (`PersonalPlanningController` / `PlanningEntry`).
 *
 * Base Route: `/planning/personal/programs`
 */
@ApiTags('Personal Planning Programs')
@ApiBearerAuth('access-token')
@Controller('planning/personal/programs')
export class PersonalPlanningProgramController {
    constructor(private readonly programService: PlanningProgramService) {}

    /** Creates a new program, optionally with its full week/day/entry tree in one call. */
    @Post()
    create(@CurrentUser() actor: Actor, @Body() dto: CreatePlanningProgramDto) {
        return this.programService.createForPersonal(actor, dto);
    }

    /** Lists the actor's personal programs (summary - weeks are listed by index only). */
    @Get()
    list(@CurrentUser() actor: Actor) {
        return this.programService.listForPersonal(actor);
    }

    /** Retrieves a single program with its full week/day/entry tree. */
    @Get(':id')
    getById(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.programService.getProgramById(actor, id);
    }

    /** Updates a program's top-level fields (name, description, cycleWeeks, timezone). */
    @Patch(':id')
    update(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: UpdatePlanningProgramDto) {
        return this.programService.updateProgram(actor, id, dto);
    }

    /** Deletes a program and its whole week/day/entry tree. */
    @Delete(':id')
    delete(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.programService.deleteProgram(actor, id);
    }

    /**
     * Creates or fully replaces a week (all its days/entries) at the given index. Extends the
     * program's cycle automatically if `weekIndex` is new - this is "ajouter une semaine".
     */
    @Put(':id/weeks/:weekIndex')
    upsertWeek(
        @CurrentUser() actor: Actor,
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
        @Param('id') id: string,
        @Param('weekIndex', ParseIntPipe) weekIndex: number,
    ) {
        return this.programService.deleteWeek(actor, id, weekIndex);
    }

    /** Replaces a single day's entries within an existing week (e.g. to add hours later). */
    @Put(':id/weeks/:weekIndex/days/:dayOfWeek')
    replaceDayEntries(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Param('weekIndex', ParseIntPipe) weekIndex: number,
        @Param('dayOfWeek', new ParseEnumPipe(PlanningWeekDay)) dayOfWeek: PlanningWeekDay,
        @Body() dto: ReplaceProgramDayDto,
    ) {
        return this.programService.replaceDayEntries(actor, id, weekIndex, dayOfWeek, dto);
    }

    /**
     * Switches the program's activation mode (OFF / CONTINUOUS / SCHEDULED) - see
     * `ScheduleProgramDto` and `PlanningProgramService.schedule()` for the exact state machine.
     */
    @Patch(':id/schedule')
    schedule(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: ScheduleProgramDto) {
        return this.programService.schedule(actor, id, dto);
    }

    /** Read-only preview of what the program resolves to on a given real date. */
    @Get(':id/preview')
    preview(@CurrentUser() actor: Actor, @Param('id') id: string, @Query('date') date: string) {
        return this.programService.previewForDate(actor, id, date);
    }

    /** Projects the program onto one specific real date in the target personal planning. */
    @Post(':id/apply')
    apply(@CurrentUser() actor: Actor, @Param('id') id: string, @Body() dto: ApplyProgramDto) {
        return this.programService.applyToDate(actor, id, dto);
    }

    /** Bulk variant of `apply` over a date range (e.g. pre-fill the next few months). */
    @Post(':id/generate')
    generate(
        @CurrentUser() actor: Actor,
        @Param('id') id: string,
        @Body() dto: GenerateProgramOccurrencesDto,
    ) {
        return this.programService.generateOccurrences(actor, id, dto);
    }
}
