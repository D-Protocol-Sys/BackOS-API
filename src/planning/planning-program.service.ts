import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma, PlanningItemType, PlanningScope, PlanningWeekDay } from '@prismamodels/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlanningService, TYPE_REQUIREMENTS } from './planning.service';
import { CreatePlanningProgramDto } from './dto/create-planning-program.dto';
import { UpdatePlanningProgramDto } from './dto/update-planning-program.dto';
import { CreateProgramWeekDto } from './dto/create-program-week.dto';
import { UpsertProgramWeekDto } from './dto/upsert-program-week.dto';
import { ReplaceProgramDayDto } from './dto/replace-program-day.dto';
import { ScheduleProgramDto, ProgramActivationMode } from './dto/schedule-program.dto';
import { ApplyProgramDto } from './dto/apply-program.dto';
import { GenerateProgramOccurrencesDto } from './dto/generate-program-occurrences.dto';

/** Authenticated user identity and permission payload extracted from JWT context. */
type Actor = { userId: string; permissions: string[] };

/** Shape representing a program along with its assigned planning container for access validation. */
type ProgramWithPlanning = Prisma.PlanningProgramGetPayload<{ include: { planning: true } }>;

/** Minimal properties required to evaluate planning-level access rights. */
type PlanningAccessShape = { scope: PlanningScope; responsibleId: string | null; platformId: string | null };

/** Maximum allowed span in days for bulk generation to prevent database overload. */
const MAX_GENERATION_RANGE_DAYS = 366;

/**
 * Service managing `PlanningProgram` instances (recurring schedule templates).
 * Handles template creation, schedule evaluation, and occurrence projection onto target plannings.
 */
@Injectable()
export class PlanningProgramService {
    private readonly logger = new Logger(PlanningProgramService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly planningService: PlanningService,
    ) {}

    // =========================================================================
    // CREATION & LISTING
    // =========================================================================

    /** Creates a program attached to the actor's personal planning. */
    async createForPersonal(actor: Actor, dto: CreatePlanningProgramDto) {
        const planning = await this.planningService.getOrCreatePersonalPlanning(actor.userId);
        return this.createProgram(actor, planning.id, dto);
    }

    /** Retrieves all recurring programs created within the actor's personal planning. */
    async listForPersonal(actor: Actor) {
        const planning = await this.planningService.findPersonalPlanning(actor.userId);
        if (!planning) return [];
        return this.listProgramsForPlanning(planning.id);
    }

    /** Creates a program attached to a platform scope after asserting edit permissions. */
    async createForPlatform(actor: Actor, platformId: string, dto: CreatePlanningProgramDto) {
        await this.planningService.assertCanEditPlatformPlanning(actor, platformId);
        const planning = await this.planningService.getOrCreatePlatformPlanning(platformId, actor.userId);
        return this.createProgram(actor, planning.id, dto);
    }

    /** Lists programs linked to a platform after asserting view permissions. */
    async listForPlatform(actor: Actor, platformId: string) {
        await this.planningService.assertCanViewPlatformPlanning(actor, platformId);
        const planning = await this.planningService.findPlatformPlanning(platformId);
        if (!planning) return [];
        return this.listProgramsForPlanning(planning.id);
    }

    /** Internal helper querying all programs for a given planning ID. */
    private listProgramsForPlanning(planningId: string) {
        return this.prisma.planningProgram.findMany({
        where: { planningId },
        orderBy: { createdAt: 'desc' },
        include: { weeks: { select: { weekIndex: true }, orderBy: { weekIndex: 'asc' } } },
        });
    }

    /**
     * Transactionally builds a program along with its week and day structures.
     * Ensures structural consistency and validates input parameters.
     */
    private async createProgram(actor: Actor, planningId: string, dto: CreatePlanningProgramDto) {
        const weeks = dto.weeks ?? [];
        const weekIndexes = weeks.map((week) => week.weekIndex);

        // Verify that week indexes are strictly unique
        if (new Set(weekIndexes).size !== weekIndexes.length) {
        throw new BadRequestException('Two weeks cannot share the same weekIndex value.');
        }

        const maxWeekIndex = weekIndexes.length ? Math.max(...weekIndexes) : -1;
        const cycleWeeks = dto.cycleWeeks ?? Math.max(1, maxWeekIndex + 1);

        // Ensure week indexes remain inside the total cycle length boundaries
        if (maxWeekIndex >= cycleWeeks) {
        throw new BadRequestException(`weekIndex ${maxWeekIndex} exceeds the specified cycle bounds (cycleWeeks=${cycleWeeks}).`);
        }

        weeks.forEach((week) => this.validateWeekDto(week));

        const created = await this.prisma.$transaction(async (tx) => {
        const program = await tx.planningProgram.create({
            data: {
            name: dto.name,
            description: dto.description,
            cycleWeeks,
            timezone: dto.timezone,
            planningId,
            createdById: actor.userId,
            },
        });

        for (const week of weeks) {
            await this.createWeekInTx(tx, program.id, week);
        }
        return program;
        });

        return this.getProgramById(actor, created.id);
    }

    // =========================================================================
    // READ / UPDATE / DELETE
    // =========================================================================

    /** Fetches a full program entity tree with ordered nested structures. */
    async getProgramById(actor: Actor, id: string) {
        const program = await this.getProgramWithPlanningOrThrow(id);
        await this.assertCanViewProgram(actor, program);

        return this.prisma.planningProgram.findUnique({
        where: { id },
        include: {
            weeks: {
            orderBy: { weekIndex: 'asc' },
            include: {
                days: {
                include: {
                    entries: { orderBy: [{ order: 'asc' }, { startTime: 'asc' }] },
                },
                },
            },
            },
        },
        });
    }

    /** Updates core program settings while preventing cycle shrinkage beneath existing index data. */
    async updateProgram(actor: Actor, id: string, dto: UpdatePlanningProgramDto) {
        const program = await this.getProgramWithPlanningOrThrow(id);
        await this.assertCanEditProgram(actor, program);

        if (dto.cycleWeeks !== undefined) {
        const maxWeekIndex = await this.prisma.planningProgramWeek.aggregate({
            where: { programId: id },
            _max: { weekIndex: true },
        });
        const highest = maxWeekIndex._max.weekIndex ?? -1;

        if (dto.cycleWeeks <= highest) {
            throw new BadRequestException(`cycleWeeks cannot be reduced below index ${highest}, which already contains entries.`);
        }
        }

        return this.prisma.planningProgram.update({
        where: { id },
        data: {
            ...(dto.name !== undefined && { name: dto.name }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.cycleWeeks !== undefined && { cycleWeeks: dto.cycleWeeks }),
            ...(dto.timezone !== undefined && { timezone: dto.timezone }),
        },
        });
    }

    /** Deletes a program and cascades through dependent relational records via schema rules. */
    async deleteProgram(actor: Actor, id: string) {
        const program = await this.getProgramWithPlanningOrThrow(id);
        await this.assertCanEditProgram(actor, program);

        await this.prisma.planningProgram.delete({ where: { id } });
        return { message: 'Program successfully deleted.' };
    }

    // =========================================================================
    // WEEKS & DAYS MANAGEMENT
    // =========================================================================

    /** Upserts a single week schedule within a program, expanding `cycleWeeks` if needed. */
    async upsertWeek(actor: Actor, programId: string, weekIndex: number, dto: UpsertProgramWeekDto) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        this.validateWeekDto({ weekIndex, days: dto.days });

        await this.prisma.$transaction(async (tx) => {
        // Auto-expand total cycle size if target week exceeds existing bounds
        if (weekIndex >= program.cycleWeeks) {
            await tx.planningProgram.update({
            where: { id: programId },
            data: { cycleWeeks: weekIndex + 1 },
            });
        }

        const existing = await tx.planningProgramWeek.findUnique({
            where: { programId_weekIndex: { programId, weekIndex } },
        });

        if (existing) {
            await tx.planningProgramWeek.delete({ where: { id: existing.id } });
        }

        await this.createWeekInTx(tx, programId, { weekIndex, days: dto.days });
        });

        return this.getProgramById(actor, programId);
    }

    /** Removes a week definition from a program cycle. */
    async deleteWeek(actor: Actor, programId: string, weekIndex: number) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        const week = await this.prisma.planningProgramWeek.findUnique({
        where: { programId_weekIndex: { programId, weekIndex } },
        });

        if (!week) {
        throw new NotFoundException('Specified week does not exist.');
        }

        await this.prisma.planningProgramWeek.delete({ where: { id: week.id } });
        return { message: 'Week successfully deleted.' };
    }

    /** Replaces all entries for a specific day in a designated program week. */
    async replaceDayEntries(actor: Actor, programId: string, weekIndex: number, dayOfWeek: PlanningWeekDay, dto: ReplaceProgramDayDto) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        dto.entries.forEach((entry) => this.validateEntryTimes(entry));

        const week = await this.prisma.planningProgramWeek.findUnique({
        where: { programId_weekIndex: { programId, weekIndex } },
        });

        if (!week) {
        throw new NotFoundException('Specified week does not exist yet. Please create it first.');
        }

        await this.prisma.$transaction(async (tx) => {
        const existingDay = await tx.planningProgramDay.findUnique({
            where: { weekId_dayOfWeek: { weekId: week.id, dayOfWeek } },
        });

        const day = existingDay ?? (await tx.planningProgramDay.create({ data: { weekId: week.id, dayOfWeek } }));

        if (existingDay) {
            await tx.planningProgramEntry.deleteMany({ where: { dayId: day.id } });
        }

        if (dto.entries.length) {
            await tx.planningProgramEntry.createMany({
            data: dto.entries.map((entry, index) => ({
                dayId: day.id,
                type: entry.type,
                title: entry.title,
                description: entry.description,
                startTime: entry.startTime,
                endTime: entry.endTime,
                order: entry.order ?? index,
            })),
            });
        }
        });

        return this.getProgramById(actor, programId);
    }

    /** Internal transactional handler to create a week and its child days/entries. */
    private async createWeekInTx(tx: Prisma.TransactionClient, programId: string, week: CreateProgramWeekDto) {
        const createdWeek = await tx.planningProgramWeek.create({
        data: { programId, weekIndex: week.weekIndex },
        });

        for (const day of week.days) {
        const createdDay = await tx.planningProgramDay.create({
            data: { weekId: createdWeek.id, dayOfWeek: day.dayOfWeek },
        });

        if (day.entries.length) {
            await tx.planningProgramEntry.createMany({
            data: day.entries.map((entry, index) => ({
                dayId: createdDay.id,
                type: entry.type,
                title: entry.title,
                description: entry.description,
                startTime: entry.startTime,
                endTime: entry.endTime,
                order: entry.order ?? index,
            })),
            });
        }
        }

        return createdWeek;
    }

    /** Validates week DTO structural rules like duplicate days and time bounds. */
    private validateWeekDto(week: { weekIndex: number; days: CreateProgramWeekDto['days'] }) {
        const days = week.days.map((day) => day.dayOfWeek);
        if (new Set(days).size !== days.length) {
        throw new BadRequestException(`Week ${week.weekIndex} contains duplicate days.`);
        }
        week.days.forEach((day) => day.entries.forEach((entry) => this.validateEntryTimes(entry)));
    }

    /** Validates logical start/end time chronological sequence. */
    private validateEntryTimes(entry: { startTime?: string; endTime?: string }) {
        if (entry.startTime && entry.endTime && entry.endTime <= entry.startTime) {
        throw new BadRequestException('endTime must be chronologically after startTime.');
        }
    }

    // =========================================================================
    // ACTIVATION STATE MACHINE
    // =========================================================================

    /** Updates program operational modes (OFF, CONTINUOUS, SCHEDULED) and anchor dates. */
    async schedule(actor: Actor, programId: string, dto: ScheduleProgramDto) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        if (dto.mode === ProgramActivationMode.OFF) {
        return this.prisma.planningProgram.update({
            where: { id: programId },
            data: { schedule: false, active: false },
        });
        }

        if (dto.mode === ProgramActivationMode.CONTINUOUS) {
        return this.prisma.planningProgram.update({
            where: { id: programId },
            data: {
            schedule: false,
            active: true,
            startDate: null,
            endDate: null,
            anchorDate: program.anchorDate ?? this.startOfDay(new Date()),
            },
        });
        }

        if (!dto.startDate) {
        throw new BadRequestException('startDate is required when using SCHEDULED mode.');
        }

        const startDate = this.startOfDay(new Date(dto.startDate));
        const endDate = dto.endDate ? this.startOfDay(new Date(dto.endDate)) : null;

        if (endDate && endDate <= startDate) {
        throw new BadRequestException('endDate must be strictly after startDate.');
        }

        const state = this.computeScheduledState(startDate, endDate, this.startOfDay(new Date()));

        return this.prisma.planningProgram.update({
        where: { id: programId },
        data: {
            schedule: state.schedule,
            active: state.active,
            startDate,
            endDate,
            anchorDate: program.anchorDate ?? startDate,
        },
        });
    }

    /** Automated daily midnight sweep evaluating activation boundaries against current time. */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async runDailyActivationSweep(): Promise<void> {
        const today = this.startOfDay(new Date());
        const scheduledPrograms = await this.prisma.planningProgram.findMany({
        where: { schedule: true },
        select: { id: true, startDate: true, endDate: true, active: true },
        });

        let flipped = 0;

        for (const program of scheduledPrograms) {
        if (!program.startDate) continue;

        const state = this.computeScheduledState(
            this.startOfDay(program.startDate),
            program.endDate ? this.startOfDay(program.endDate) : null,
            today,
        );

        if (state.schedule !== true || state.active !== program.active) {
            await this.prisma.planningProgram.update({
            where: { id: program.id },
            data: { schedule: state.schedule, active: state.active },
            });
            flipped += 1;
        }
        }

        if (flipped > 0) {
        this.logger.log(`Activation sweep completed: ${flipped} program(s) updated.`);
        } else {
        this.logger.debug('Activation sweep completed: no updates required.');
        }
    }

    /** Pure function evaluating active status flags given a target date context. */
    private computeScheduledState(startDate: Date, endDate: Date | null, today: Date) {
        if (endDate && today >= endDate) {
        return { schedule: false, active: false };
        }
        if (today >= startDate) {
        return { schedule: Boolean(endDate), active: true };
        }
        return { schedule: true, active: false };
    }

    /** Evaluates whether a date falls within an active runtime window of a program. */
    private isEffectiveOn(
        program: { schedule: boolean; active: boolean; startDate: Date | null; endDate: Date | null },
        date: Date,
    ): boolean {
        const day = this.startOfDay(date);

        if (!program.schedule && !program.active) return false;
        if (!program.schedule && program.active) return true;
        if (!program.startDate) return false;

        const start = this.startOfDay(program.startDate);
        if (day < start) return false;

        if (program.endDate) {
        const end = this.startOfDay(program.endDate);
        if (day >= end) return false;
        }

        return true;
    }

    // =========================================================================
    // CYCLE RESOLUTION & TIME CALCULATIONS
    // =========================================================================

    private static readonly JS_DAY_TO_WEEKDAY: PlanningWeekDay[] = [
        PlanningWeekDay.SUNDAY,
        PlanningWeekDay.MONDAY,
        PlanningWeekDay.TUESDAY,
        PlanningWeekDay.WEDNESDAY,
        PlanningWeekDay.THURSDAY,
        PlanningWeekDay.FRIDAY,
        PlanningWeekDay.SATURDAY,
    ];

    /** Maps a calendar date to its cycle week index using modular arithmetic relative to anchor date. */
    private resolveCycleWeekIndex(
        program: { anchorDate: Date | null; startDate: Date | null; createdAt: Date; cycleWeeks: number },
        date: Date,
    ): number {
        const anchor = this.startOfDay(program.anchorDate ?? program.startDate ?? program.createdAt);
        const day = this.startOfDay(date);

        const diffDays = Math.round((day.getTime() - anchor.getTime()) / 86_400_000);
        const diffWeeks = Math.floor(diffDays / 7);
        const cycleWeeks = Math.max(1, program.cycleWeeks);

        // Euclidean modulo ensuring non-negative values for historical calculations
        return ((diffWeeks % cycleWeeks) + cycleWeeks) % cycleWeeks;
    }

    /** Converts JavaScript date object to domain `PlanningWeekDay` enum. */
    private resolveDayOfWeek(date: Date): PlanningWeekDay {
        return PlanningProgramService.JS_DAY_TO_WEEKDAY[this.startOfDay(date).getUTCDay()];
    }

    /** Zeroes out hours, minutes, seconds, and milliseconds in UTC. */
    private startOfDay(date: Date): Date {
        const normalized = new Date(date);
        normalized.setUTCHours(0, 0, 0, 0);
        return normalized;
    }

    /** Fetches template entry entries matching week index and weekday constraints. */
    private async findTemplateDay(programId: string, weekIndex: number, dayOfWeek: PlanningWeekDay) {
        return this.prisma.planningProgramDay.findFirst({
        where: { dayOfWeek, week: { programId, weekIndex } },
        include: { entries: { orderBy: [{ order: 'asc' }, { startTime: 'asc' }] } },
        });
    }

    // =========================================================================
    // PREVIEW & PROJECTION ONTO PLANNING
    // =========================================================================

    /** Evaluates and previews mapped entries for a specific target date without mutating data. */
    async previewForDate(actor: Actor, programId: string, dateStr: string) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanViewProgram(actor, program);

        const date = this.startOfDay(new Date(dateStr));

        if (!this.isEffectiveOn(program, date)) {
        return { date: dateStr, active: false, entries: [] };
        }

        const weekIndex = this.resolveCycleWeekIndex(program, date);
        const dayOfWeek = this.resolveDayOfWeek(date);
        const day = await this.findTemplateDay(programId, weekIndex, dayOfWeek);

        return {
        date: dateStr,
        active: true,
        weekIndex,
        dayOfWeek,
        entries: day?.entries ?? [],
        };
    }

    /** Projects template items for a single date directly into a target planning scope. */
    async applyToDate(actor: Actor, programId: string, dto: ApplyProgramDto) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);
        await this.assertCanEditPlanningById(actor, dto.planningId);

        const date = this.startOfDay(new Date(dto.date));

        if (!this.isEffectiveOn(program, date)) {
        throw new BadRequestException('Program is not active on the specified date.');
        }

        const weekIndex = this.resolveCycleWeekIndex(program, date);
        const dayOfWeek = this.resolveDayOfWeek(date);
        const day = await this.findTemplateDay(programId, weekIndex, dayOfWeek);

        if (!day || day.entries.length === 0) return [];

        const results: Awaited<ReturnType<typeof this.materializeEntry>>[] = [];
        for (const templateEntry of day.entries) {
        results.push(await this.materializeEntry(templateEntry, dto.planningId, date, actor.userId));
        }
        return results;
    }

    /** Generates real concrete `PlanningEntry` records across a broad date range with day-caching optimization. */
    async generateOccurrences(actor: Actor, programId: string, dto: GenerateProgramOccurrencesDto) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);
        await this.assertCanEditPlanningById(actor, dto.planningId);

        const rangeStart = this.startOfDay(new Date(dto.rangeStart));
        const rangeEnd = this.startOfDay(new Date(dto.rangeEnd));

        if (rangeEnd < rangeStart) {
        throw new BadRequestException('rangeEnd must be chronologically greater than or equal to rangeStart.');
        }

        const totalDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / 86_400_000) + 1;
        if (totalDays > MAX_GENERATION_RANGE_DAYS) {
        throw new BadRequestException(`Date range cannot exceed ${MAX_GENERATION_RANGE_DAYS} days.`);
        }

        const dayCache = new Map<string, Awaited<ReturnType<typeof this.findTemplateDay>>>();
        const entries: Awaited<ReturnType<typeof this.materializeEntry>>[] = [];

        for (let i = 0; i < totalDays; i += 1) {
        const date = new Date(rangeStart);
        date.setUTCDate(date.getUTCDate() + i);

        if (!this.isEffectiveOn(program, date)) continue;

        const weekIndex = this.resolveCycleWeekIndex(program, date);
        const dayOfWeek = this.resolveDayOfWeek(date);
        const cacheKey = `${weekIndex}:${dayOfWeek}`;

        let day = dayCache.get(cacheKey);
        if (day === undefined) {
            day = await this.findTemplateDay(programId, weekIndex, dayOfWeek);
            dayCache.set(cacheKey, day);
        }

        if (!day || day.entries.length === 0) continue;

        for (const templateEntry of day.entries) {
            entries.push(await this.materializeEntry(templateEntry, dto.planningId, date, actor.userId));
        }
        }

        return { generatedCount: entries.length, entries };
    }

    /** Materializes one template entry as a `PlanningEntry` using upserts on `(programEntryId, occurrenceDate)`. */
    private async materializeEntry(
        templateEntry: {
        id: string;
        type: PlanningItemType;
        title: string;
        description: string | null;
        startTime: string | null;
        endTime: string | null;
        },
        planningId: string,
        date: Date,
        creatorId: string,
    ) {
        const { startAt, endAt, dueDate, targetDate } = this.resolveOccurrenceDates(templateEntry, date);

        return this.prisma.planningEntry.upsert({
        where: {
            programEntryId_occurrenceDate: {
            programEntryId: templateEntry.id,
            occurrenceDate: date,
            },
        },
        create: {
            type: templateEntry.type,
            title: templateEntry.title,
            description: templateEntry.description ?? undefined,
            startAt,
            endAt,
            dueDate,
            targetDate,
            planningId,
            programEntryId: templateEntry.id,
            occurrenceDate: date,
            creatorId,
        },
        update: {
            title: templateEntry.title,
            description: templateEntry.description ?? undefined,
            startAt,
            endAt,
            dueDate,
            targetDate,
        },
        });
    }

    /** Computes absolute date fields required by item type rules in `TYPE_REQUIREMENTS`. */
    private resolveOccurrenceDates(
        entry: { type: PlanningItemType; startTime: string | null; endTime: string | null },
        date: Date,
    ) {
        const rules = TYPE_REQUIREMENTS[entry.type];

        return {
        startAt: rules.required.includes('startAt') ? this.combineDateAndTime(date, entry.startTime, '00:00') : undefined,
        endAt: rules.required.includes('endAt') ? this.combineDateAndTime(date, entry.endTime, '23:59') : undefined,
        dueDate: rules.required.includes('dueDate') ? this.combineDateAndTime(date, entry.endTime ?? entry.startTime, '23:59') : undefined,
        targetDate: rules.required.includes('targetDate') ? this.combineDateAndTime(date, entry.startTime, '00:00') : undefined,
        };
    }

    /** Helper merging a Date object with an "HH:mm" time string into a UTC Date. */
    private combineDateAndTime(date: Date, time: string | null | undefined, fallback: string): Date {
        const [hours, minutes] = (time ?? fallback).split(':').map(Number);
        const combined = new Date(date);
        combined.setUTCHours(hours, minutes, 0, 0);
        return combined;
    }

    // =========================================================================
    // ACCESS CONTROL & PERMISSIONS
    // =========================================================================

    /** Fetches a program with planning relations or throws a `NotFoundException`. */
    private async getProgramWithPlanningOrThrow(id: string): Promise<ProgramWithPlanning> {
        const program = await this.prisma.planningProgram.findUnique({
        where: { id },
        include: { planning: true },
        });

        if (!program) {
        throw new NotFoundException('Program not found.');
        }

        return program;
    }

    /** Validates read rights depending on whether program is a standalone template or bound to a planning. */
    private async assertCanViewProgram(actor: Actor, program: ProgramWithPlanning) {
        if (!program.planning) {
        if (program.createdById !== actor.userId) {
            throw new ForbiddenException('You do not own this template.');
        }
        return;
        }
        await this.assertCanViewPlanning(actor, program.planning);
    }

    /** Validates edit rights depending on whether program is a standalone template or bound to a planning. */
    private async assertCanEditProgram(actor: Actor, program: ProgramWithPlanning) {
        if (!program.planning) {
        if (program.createdById !== actor.userId) {
            throw new ForbiddenException('Only the creator of this template can modify it.');
        }
        return;
        }
        await this.assertCanEditPlanning(actor, program.planning);
    }

    /** Asserts read permissions on a planning based on its Personal or Platform scope. */
    private async assertCanViewPlanning(actor: Actor, planning: PlanningAccessShape) {
        if (planning.scope === PlanningScope.PERSONAL) {
        if (planning.responsibleId !== actor.userId) {
            throw new ForbiddenException('Access denied.');
        }
        return;
        }

        if (planning.scope === PlanningScope.PLATFORM) {
        if (!planning.platformId) {
            throw new ForbiddenException('Platform planning context is missing.');
        }
        await this.planningService.assertCanViewPlatformPlanning(actor, planning.platformId);
        return;
        }

        throw new ForbiddenException('Access denied.');
    }

    /** Asserts write permissions on a planning based on its Personal or Platform scope. */
    private async assertCanEditPlanning(actor: Actor, planning: PlanningAccessShape) {
        if (planning.scope === PlanningScope.PERSONAL) {
        if (planning.responsibleId !== actor.userId) {
            throw new ForbiddenException('Access denied.');
        }
        return;
        }

        if (planning.scope === PlanningScope.PLATFORM) {
        if (!planning.platformId) {
            throw new ForbiddenException('Platform planning context is missing.');
        }
        await this.planningService.assertCanEditPlatformPlanning(actor, planning.platformId);
        return;
        }

        throw new ForbiddenException('Access denied.');
    }

    /** Resolves target planning by ID and checks actor write permissions. */
    private async assertCanEditPlanningById(actor: Actor, planningId: string) {
        const planning = await this.prisma.planning.findUnique({ where: { id: planningId } });

        if (!planning) {
        throw new NotFoundException('Target planning not found.');
        }

        await this.assertCanEditPlanning(actor, planning);
    }
}