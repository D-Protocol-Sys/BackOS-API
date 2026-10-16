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

type Actor = { userId: string; permissions: string[] };
type ProgramWithPlanning = Prisma.PlanningProgramGetPayload<{ include: { planning: true } }>;
type PlanningAccessShape = { scope: PlanningScope; responsibleId: string | null; platformId: string | null };

const MAX_GENERATION_RANGE_DAYS = 366;
const DAY_MS = 86_400_000;

/**
 * PlanningProgramService manages reusable planning templates.
 *
 * A program describes a recurring schedule such as:
 * - "Sport every Monday, Wednesday and Saturday"
 * - "Courses every weekday"
 * - "Work shift every two weeks"
 *
 * The program itself does not represent a real calendar occurrence.
 * Real occurrences are stored as PlanningEntry records.
 *
 * Main responsibilities:
 * 1. Manage programs, weeks, days and template entries.
 * 2. Manage the schedule/active state machine.
 * 3. Project program templates into real PlanningEntry records.
 */
@Injectable()
export class PlanningProgramService {
    private readonly logger = new Logger(PlanningProgramService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly planningService: PlanningService,
    ) {}

    // =========================================================================
    // PROGRAM CREATION & LISTING
    // =========================================================================

    /** Creates a program inside the user's personal planning. */
    async createForPersonal(actor: Actor, dto: CreatePlanningProgramDto) {
        const planning = await this.planningService.getOrCreatePersonalPlanning(actor.userId);
        return this.createProgram(actor, planning.id, dto);
    }

    /** Returns all programs belonging to the user's personal planning. */
    async listForPersonal(actor: Actor) {
        const planning = await this.planningService.findPersonalPlanning(actor.userId);
        return planning ? this.listProgramsForPlanning(planning.id) : [];
    }

    /** Creates a program inside a platform planning after checking edit permission. */
    async createForPlatform(actor: Actor, platformId: string, dto: CreatePlanningProgramDto) {
        await this.planningService.assertCanEditPlatformPlanning(actor, platformId);
        const planning = await this.planningService.getOrCreatePlatformPlanning(platformId, actor.userId);
        return this.createProgram(actor, planning.id, dto);
    }

    /** Returns all programs attached to a platform planning. */
    async listForPlatform(actor: Actor, platformId: string) {
        await this.planningService.assertCanViewPlatformPlanning(actor, platformId);
        const planning = await this.planningService.findPlatformPlanning(platformId);
        return planning ? this.listProgramsForPlanning(planning.id) : [];
    }

    private listProgramsForPlanning(planningId: string) {
        return this.prisma.planningProgram.findMany({
            where: { planningId },
            orderBy: { createdAt: 'desc' },
            include: {
                weeks: { select: { weekIndex: true }, orderBy: { weekIndex: 'asc' } },
            },
        });
    }

    /**
     * Creates the program and optionally its complete week/day/entry tree.
     *
     * Everything is wrapped in one transaction so that a partially created
     * program can never remain in the database if one child creation fails.
     */
    private async createProgram(actor: Actor, planningId: string, dto: CreatePlanningProgramDto) {
        const weeks = dto.weeks ?? [];
        const indexes = weeks.map((w) => w.weekIndex);

        if (new Set(indexes).size !== indexes.length) {
            throw new BadRequestException('Two weeks cannot use the same weekIndex.');
        }

        const maxWeekIndex = indexes.length ? Math.max(...indexes) : -1;
        const cycleWeeks = dto.cycleWeeks ?? Math.max(1, maxWeekIndex + 1);

        if (maxWeekIndex >= cycleWeeks) {
            throw new BadRequestException(`weekIndex ${maxWeekIndex} is outside the cycle (cycleWeeks=${cycleWeeks}).`);
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

    /** Returns a program with its complete week/day/entry hierarchy. */
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

    /** Updates only the top-level program properties. */
    async updateProgram(actor: Actor, id: string, dto: UpdatePlanningProgramDto) {
        const program = await this.getProgramWithPlanningOrThrow(id);
        await this.assertCanEditProgram(actor, program);

        if (dto.cycleWeeks !== undefined) {
            const result = await this.prisma.planningProgramWeek.aggregate({
                where: { programId: id },
                _max: { weekIndex: true },
            });

            const highest = result._max.weekIndex ?? -1;

            // Prevent deleting the logical part of the cycle that is already populated.
            if (dto.cycleWeeks <= highest) {
                throw new BadRequestException(`cycleWeeks cannot be reduced below populated week ${highest}.`);
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

    /** Permanently deletes a program and its child hierarchy. */
    async deleteProgram(actor: Actor, id: string) {
        const program = await this.getProgramWithPlanningOrThrow(id);
        await this.assertCanEditProgram(actor, program);

        await this.prisma.planningProgram.delete({ where: { id } });
        return { message: 'Program deleted successfully.' };
    }

    // =========================================================================
    // WEEKS & DAYS
    // =========================================================================

    /**
     * Creates or completely replaces a week.
     *
     * If the requested weekIndex is outside the current cycle,
     * the cycle automatically grows to include it.
     */
    async upsertWeek(actor: Actor, programId: string, weekIndex: number, dto: UpsertProgramWeekDto) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);
        this.validateWeekDto({ weekIndex, days: dto.days });

        await this.prisma.$transaction(async (tx) => {
            if (weekIndex >= program.cycleWeeks) {
                await tx.planningProgram.update({
                    where: { id: programId },
                    data: { cycleWeeks: weekIndex + 1 },
                });
            }

            const existing = await tx.planningProgramWeek.findUnique({
                where: { programId_weekIndex: { programId, weekIndex } },
            });

            // Deleting the week also deletes its days and entries through database cascades.
            if (existing) {
                await tx.planningProgramWeek.delete({ where: { id: existing.id } });
            }

            await this.createWeekInTx(tx, programId, { weekIndex, days: dto.days });
        });

        return this.getProgramById(actor, programId);
    }

    /** Deletes an entire week and its child days/entries. */
    async deleteWeek(actor: Actor, programId: string, weekIndex: number) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        const week = await this.prisma.planningProgramWeek.findUnique({
            where: { programId_weekIndex: { programId, weekIndex } },
        });

        if (!week) {
            throw new NotFoundException('This week does not exist.');
        }

        await this.prisma.planningProgramWeek.delete({ where: { id: week.id } });
        return { message: 'Week deleted successfully.' };
    }

    /**
     * Replaces only one day's entries.
     *
     * This is intentionally smaller than replacing the whole week:
     * clients can modify one day without sending the entire program structure.
     */
    async replaceDayEntries(
        actor: Actor,
        programId: string,
        weekIndex: number,
        dayOfWeek: PlanningWeekDay,
        dto: ReplaceProgramDayDto,
    ) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);
        dto.entries.forEach((entry) => this.validateEntryTimes(entry));

        const week = await this.prisma.planningProgramWeek.findUnique({
            where: { programId_weekIndex: { programId, weekIndex } },
        });

        if (!week) {
            throw new NotFoundException('This week does not exist yet. Create it first.');
        }

        await this.prisma.$transaction(async (tx) => {
            const existingDay = await tx.planningProgramDay.findUnique({
                where: { weekId_dayOfWeek: { weekId: week.id, dayOfWeek } },
            });

            const day =
                existingDay ??
                (await tx.planningProgramDay.create({
                    data: { weekId: week.id, dayOfWeek },
                }));

            if (existingDay) {
                // Full replacement: remove the previous template entries first.
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

    /** Creates a week and its complete child tree inside an existing transaction. */
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

    /**
     * Validates a week before touching the database.
     *
     * A week cannot contain the same weekday twice because the combination
     * (weekIndex + dayOfWeek) identifies one template day.
     */
    private validateWeekDto(week: { weekIndex: number; days: CreateProgramWeekDto['days'] }) {
        const days = week.days.map((day) => day.dayOfWeek);

        if (new Set(days).size !== days.length) {
            throw new BadRequestException(`Week ${week.weekIndex} contains the same day more than once.`);
        }

        week.days.forEach((day) => day.entries.forEach((entry) => this.validateEntryTimes(entry)));
    }

    /** Ensures an entry never ends before or exactly when it starts. */
    private validateEntryTimes(entry: { startTime?: string; endTime?: string }) {
        if (entry.startTime && entry.endTime && entry.endTime <= entry.startTime) {
            throw new BadRequestException('endTime must be later than startTime.');
        }
    }

    // =========================================================================
    // ACTIVATION STATE MACHINE
    // =========================================================================

    /**
     * Changes the program activation mode.
     *
     * OFF:
     *   schedule=false, active=false
     *
     * CONTINUOUS:
     *   schedule=false, active=true
     *
     * SCHEDULED:
     *   schedule=true before the start date,
     *   schedule=true + active=true while running,
     *   both false after the end date.
     */
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
                    // Keep the original anchor so the cycle never shifts when reactivated.
                    anchorDate: program.anchorDate ?? this.startOfDay(new Date()),
                },
            });
        }

        if (!dto.startDate) {
            throw new BadRequestException('startDate is required for SCHEDULED mode.');
        }

        const startDate = this.startOfDay(new Date(dto.startDate));
        const endDate = dto.endDate ? this.startOfDay(new Date(dto.endDate)) : null;

        if (endDate && endDate <= startDate) {
            throw new BadRequestException('endDate must be later than startDate.');
        }

        const state = this.computeScheduledState(startDate, endDate, this.startOfDay(new Date()));

        return this.prisma.planningProgram.update({
            where: { id: programId },
            data: {
                schedule: state.schedule,
                active: state.active,
                startDate,
                endDate,
                // The anchor is established once and remains stable for the entire cycle.
                anchorDate: program.anchorDate ?? startDate,
            },
        });
    }

    /**
     * Runs every midnight and updates scheduled programs.
     *
     * The database does not automatically know that a calendar date has changed.
     * This cron therefore keeps `schedule` and `active` synchronized with the dates.
     */
    @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
    async runDailyActivationSweep(): Promise<void> {
        const today = this.startOfDay(new Date());

        const programs = await this.prisma.planningProgram.findMany({
            where: { schedule: true },
            select: { id: true, startDate: true, endDate: true, active: true },
        });

        let updated = 0;

        for (const program of programs) {
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
                updated++;
            }
        }

        if (updated) {
            this.logger.log(`Activation sweep: ${updated} program(s) updated.`);
        } else {
            this.logger.debug('Activation sweep: no programs required an update.');
        }
    }

    /**
     * Computes the exact state of a scheduled program for a specific day.
     *
     * This is a pure function, which is useful because both `schedule()` and
     * the daily cron use exactly the same business rule.
     */
    private computeScheduledState(startDate: Date, endDate: Date | null, today: Date) {
        if (endDate && today >= endDate) return { schedule: false, active: false };

        if (today >= startDate) {
            // A bounded program stays scheduled while it is running.
            // An unbounded program behaves like continuous activation.
            return { schedule: Boolean(endDate), active: true };
        }

        return { schedule: true, active: false };
    }

    /**
     * Determines whether the program should generate an occurrence on `date`.
     *
     * This deliberately uses dates instead of relying only on `active`.
     * `active` may be updated by the midnight cron, while generation can happen
     * immediately after a schedule change.
     */
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

        if (program.endDate && day >= this.startOfDay(program.endDate)) return false;

        return true;
    }

    // =========================================================================
    // CYCLE RESOLUTION
    // =========================================================================

    /**
     * JavaScript's getUTCDay() returns:
     * 0 = Sunday, 1 = Monday, ..., 6 = Saturday.
     *
     * This array converts that native number into the Prisma enum.
     */
    private static readonly JS_DAY_TO_WEEKDAY: PlanningWeekDay[] = [
        PlanningWeekDay.SUNDAY,
        PlanningWeekDay.MONDAY,
        PlanningWeekDay.TUESDAY,
        PlanningWeekDay.WEDNESDAY,
        PlanningWeekDay.THURSDAY,
        PlanningWeekDay.FRIDAY,
        PlanningWeekDay.SATURDAY,
    ];

    /**
     * Converts a real calendar date into a cycle week.
     *
     * Example with a 2-week cycle:
     * Week 0 -> days 0-6
     * Week 1 -> days 7-13
     * Week 0 -> days 14-20
     *
     * The modulo normalization is important for dates before the anchor,
     * because JavaScript can return negative values from `%`.
     */
    private resolveCycleWeekIndex(
        program: { anchorDate: Date | null; startDate: Date | null; createdAt: Date; cycleWeeks: number },
        date: Date,
    ): number {
        const anchor = this.startOfDay(program.anchorDate ?? program.startDate ?? program.createdAt);
        const day = this.startOfDay(date);
        const diffDays = Math.round((day.getTime() - anchor.getTime()) / DAY_MS);
        const diffWeeks = Math.floor(diffDays / 7);
        const cycleWeeks = Math.max(1, program.cycleWeeks);

        return ((diffWeeks % cycleWeeks) + cycleWeeks) % cycleWeeks;
    }

    private resolveDayOfWeek(date: Date): PlanningWeekDay {
        return PlanningProgramService.JS_DAY_TO_WEEKDAY[this.startOfDay(date).getUTCDay()];
    }

    /** Normalizes dates to midnight UTC to make calendar-day comparisons deterministic. */
    private startOfDay(date: Date): Date {
        const normalized = new Date(date);
        normalized.setUTCHours(0, 0, 0, 0);
        return normalized;
    }

    /**
     * Finds the template day corresponding to a cycle week + weekday.
     *
     * The entries are returned in display order.
     */
    private findTemplateDay(programId: string, weekIndex: number, dayOfWeek: PlanningWeekDay) {
        return this.prisma.planningProgramDay.findFirst({
            where: { dayOfWeek, week: { programId, weekIndex } },
            include: { entries: { orderBy: [{ order: 'asc' }, { startTime: 'asc' }] } },
        });
    }

    // =========================================================================
    // PREVIEW & PROJECTION
    // =========================================================================

    /**
     * Returns what a program would generate on a specific date without
     * creating anything in the real planning.
     */
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

    /** Applies a program to one date in the user's personal planning. */
    async applyToPersonalDate(actor: Actor, programId: string, dto: ApplyProgramDto) {
        const planning = await this.planningService.getOrCreatePersonalPlanning(actor.userId);
        return this.applyToDate(actor, programId, planning.id, dto.date);
    }

    /** Applies a program to one date in a platform planning. */
    async applyToPlatformDate(actor: Actor, platformId: string, programId: string, dto: ApplyProgramDto) {
        await this.planningService.assertCanEditPlatformPlanning(actor, platformId);
        const planning = await this.planningService.getOrCreatePlatformPlanning(platformId, actor.userId);
        return this.applyToDate(actor, programId, planning.id, dto.date);
    }

    /**
     * Materializes a program onto one real calendar date.
     *
     * The important separation is:
     * Template:
     *   PlanningProgramEntry
     *
     * Real calendar:
     *   PlanningEntry
     *
     * The unique `(programEntryId, occurrenceDate)` constraint makes this operation
     * idempotent: running it twice updates the same occurrence instead of duplicating it.
     */
    private async applyToDate(actor: Actor, programId: string, planningId: string, dateStr: string) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        const date = this.startOfDay(new Date(dateStr));

        if (!this.isEffectiveOn(program, date)) {
            throw new BadRequestException('This program is not active on the specified date.');
        }

        const weekIndex = this.resolveCycleWeekIndex(program, date);
        const dayOfWeek = this.resolveDayOfWeek(date);
        const day = await this.findTemplateDay(programId, weekIndex, dayOfWeek);

        if (!day?.entries.length) return [];

        type MaterializedEntry = Awaited<ReturnType<PlanningProgramService['materializeEntry']>>;

        const results: MaterializedEntry[] = [];

        for (const entry of day.entries) {
            results.push(await this.materializeEntry(entry, planningId, date, actor.userId));
        }

        return results;
    }

    /** Generates occurrences in the user's personal planning. */
    async generateForPersonal(actor: Actor, programId: string, dto: GenerateProgramOccurrencesDto) {
        const planning = await this.planningService.getOrCreatePersonalPlanning(actor.userId);
        return this.generateOccurrences(actor, programId, planning.id, dto);
    }

    /** Generates occurrences in a platform planning. */
    async generateForPlatform(actor: Actor, platformId: string, programId: string, dto: GenerateProgramOccurrencesDto) {
        await this.planningService.assertCanEditPlatformPlanning(actor, platformId);
        const planning = await this.planningService.getOrCreatePlatformPlanning(platformId, actor.userId);
        return this.generateOccurrences(actor, programId, planning.id, dto);
    }

    /**
     * Generates all occurrences inside a date range.
     *
     * A small in-memory cache avoids repeatedly querying the same template day.
     * For example, a 3-month range on a 2-week cycle repeatedly needs only
     * 14 unique (weekIndex + weekday) combinations.
     */
    private async generateOccurrences(
        actor: Actor,
        programId: string,
        planningId: string,
        dto: GenerateProgramOccurrencesDto,
    ) {
        const program = await this.getProgramWithPlanningOrThrow(programId);
        await this.assertCanEditProgram(actor, program);

        const rangeStart = this.startOfDay(new Date(dto.rangeStart));
        const rangeEnd = this.startOfDay(new Date(dto.rangeEnd));

        if (rangeEnd < rangeStart) {
            throw new BadRequestException('rangeEnd must be greater than or equal to rangeStart.');
        }

        const totalDays = Math.round((rangeEnd.getTime() - rangeStart.getTime()) / DAY_MS) + 1;

        if (totalDays > MAX_GENERATION_RANGE_DAYS) {
            throw new BadRequestException(`The date range cannot exceed ${MAX_GENERATION_RANGE_DAYS} days.`);
        }

        const dayCache = new Map<string, Awaited<ReturnType<typeof this.findTemplateDay>>>();
        const entries: Awaited<ReturnType<typeof this.materializeEntry>>[] = [];

        for (let i = 0; i < totalDays; i++) {
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

            if (!day?.entries.length) continue;

            for (const templateEntry of day.entries) {
                entries.push(await this.materializeEntry(templateEntry, planningId, date, actor.userId));
            }
        }

        return { generatedCount: entries.length, entries };
    }

    /**
     * Converts one template entry into a real PlanningEntry.
     *
     * The target dates are calculated according to TYPE_REQUIREMENTS so generated
     * entries follow exactly the same date rules as manually created entries.
     */
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

    /**
     * Builds the absolute date fields required by each PlanningItemType.
     *
     * This keeps program generation aligned with PlanningService validation.
     */
    private resolveOccurrenceDates(
        entry: { type: PlanningItemType; startTime: string | null; endTime: string | null },
        date: Date,
    ) {
        const rules = TYPE_REQUIREMENTS[entry.type];

        return {
            startAt: rules.required.includes('startAt')
                ? this.combineDateAndTime(date, entry.startTime, '00:00')
                : undefined,
            endAt: rules.required.includes('endAt') ? this.combineDateAndTime(date, entry.endTime, '23:59') : undefined,
            dueDate: rules.required.includes('dueDate')
                ? this.combineDateAndTime(date, entry.endTime ?? entry.startTime, '23:59')
                : undefined,
            targetDate: rules.required.includes('targetDate')
                ? this.combineDateAndTime(date, entry.startTime, '00:00')
                : undefined,
        };
    }

    /** Combines a normalized calendar date with an HH:mm time. */
    private combineDateAndTime(date: Date, time: string | null | undefined, fallback: string): Date {
        const [hours, minutes] = (time ?? fallback).split(':').map(Number);
        const combined = new Date(date);
        combined.setUTCHours(hours, minutes, 0, 0);
        return combined;
    }

    // =========================================================================
    // ACCESS CONTROL
    // =========================================================================

    /** Loads the program and its planning context or throws a 404. */
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

    /**
     * A program without a planning behaves like a private reusable template:
     * only its creator can access it.
     *
     * When attached to a planning, access follows the planning's own rules.
     */
    private async assertCanViewProgram(actor: Actor, program: ProgramWithPlanning) {
        if (!program.planning) {
            if (program.createdById !== actor.userId) {
                throw new ForbiddenException('You do not own this template.');
            }
            return;
        }

        await this.assertCanViewPlanning(actor, program.planning);
    }

    /** Same ownership/planning rules as read access, but for write operations. */
    private async assertCanEditProgram(actor: Actor, program: ProgramWithPlanning) {
        if (!program.planning) {
            if (program.createdById !== actor.userId) {
                throw new ForbiddenException('Only the creator of this template can modify it.');
            }
            return;
        }

        await this.assertCanEditPlanning(actor, program.planning);
    }

    /**
     * Resolves read permissions according to the planning scope.
     *
     * PERSONAL:
     *   Only the responsible user.
     *
     * PLATFORM:
     *   Delegates authorization to PlanningService.
     *
     * TEAM:
     *   Currently rejected because program access rules do not define team access yet.
     */
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

    /** Resolves write permissions according to the planning scope. */
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
}
