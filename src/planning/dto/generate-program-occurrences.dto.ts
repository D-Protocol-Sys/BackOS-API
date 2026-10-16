import { IsDateString } from 'class-validator';

/**
 * Data Transfer Object (DTO) used to bulk-project a `PlanningProgram` onto a real date range
 * (`POST /.../programs/:id/generate`) - e.g. pre-fill the next three months of the real
 * planning from the "Sport" program in one call, instead of calling `apply` day by day.
 *
 * The target `Planning` (personal or platform) is never passed in the body - see
 * `ApplyProgramDto` for why.
 *
 * Generation is entirely idempotent (safe to re-run over an overlapping range): each produced
 * `PlanningEntry` is upserted on `(programEntryId, occurrenceDate)`, so re-generating an
 * already-covered period updates rather than duplicates its entries.
 */
export class GenerateProgramOccurrencesDto {
    /**
     * Start of the range (inclusive). ISO 8601 date string, e.g. "2026-09-14".
     */
    @IsDateString()
    rangeStart!: string;

    /**
     * End of the range (inclusive). ISO 8601 date string, e.g. "2026-12-14".
     * Capped to 366 days after `rangeStart` - see `PlanningProgramService.generateOccurrences()`.
     */
    @IsDateString()
    rangeEnd!: string;
}
