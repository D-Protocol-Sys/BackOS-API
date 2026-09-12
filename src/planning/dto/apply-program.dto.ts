import { IsUUID, IsDateString } from 'class-validator';

/**
 * Data Transfer Object (DTO) used to project a `PlanningProgram` onto one specific real
 * calendar date (`POST /.../programs/:id/apply`) - e.g. "put the Sport program's content for
 * this particular Friday into my real planning at 18h-20h".
 *
 * The caller never has to say *which* week of the cycle that Friday belongs to: it's derived
 * from the program's `anchorDate`/`cycleWeeks`, which is exactly what makes two different
 * Fridays resolve to two different pieces of content automatically (see
 * `PlanningProgramService.resolveCycleDay()`).
 */
export class ApplyProgramDto {

    /**
     * Target `Planning.id` (personal or platform) the generated entries should land in.
     */
    @IsUUID()
    planningId!: string;

    /**
     * The real calendar date to project the program onto. ISO 8601 date string,
     * e.g. "2026-09-18". Only the calendar day matters - any time component is ignored.
     */
    @IsDateString()
    date!: string;
}
