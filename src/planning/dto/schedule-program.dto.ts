import { IsEnum, IsOptional, IsDateString, ValidateIf } from 'class-validator';

/**
 * The three activation modes a `PlanningProgram` can be put into. Mirrors exactly the
 * `schedule`/`active` state machine documented on `PlanningProgram` in `schema.prisma`:
 *
 * - `OFF`        -> schedule=false, active=false  (never activated / fully stopped)
 * - `CONTINUOUS` -> schedule=false, active=true   (loops forever, no start/end date)
 * - `SCHEDULED`  -> schedule=true                 (bound to a startDate, optionally an
 *                    endDate; `active` then flips automatically over time - see
 *                    `PlanningProgramService.runDailyActivationSweep()`)
 */
export enum ProgramActivationMode {
    OFF = 'OFF',
    CONTINUOUS = 'CONTINUOUS',
    SCHEDULED = 'SCHEDULED',
}

/**
 * Data Transfer Object (DTO) used to change a program's activation state
 * (`PATCH /.../programs/:id/schedule`).
 */
export class ScheduleProgramDto {

    /**
     * Which activation mode to switch the program into.
     */
    @IsEnum(ProgramActivationMode)
    mode!: ProgramActivationMode;

    /**
     * Required when `mode` is `SCHEDULED`. The day the program starts applying.
     * ISO 8601 date string, e.g. "2026-09-14".
     */
    @ValidateIf((dto: ScheduleProgramDto) => dto.mode === ProgramActivationMode.SCHEDULED)
    @IsDateString()
    startDate?: string;

    /**
     * Optional even when `mode` is `SCHEDULED`. Leaving it unset means the program keeps
     * repeating indefinitely once started, until it's explicitly re-scheduled with an end
     * date or switched off.
     */
    @IsOptional()
    @IsDateString()
    endDate?: string;
}
