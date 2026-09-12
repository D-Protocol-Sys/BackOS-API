import {
    IsEnum, IsString, IsOptional, MinLength, MaxLength, IsInt, Min, Matches,
} from 'class-validator';
import { PlanningItemType } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) describing one recurring template item attached to a single day
 * of a `PlanningProgram` cycle (e.g. "Musculation" on Monday, "Cours d'anglais" on Tuesday).
 *
 * This is the "recipe" shape - it never carries an absolute date. `startTime`/`endTime` are
 * plain "HH:mm" clock times relative to whichever calendar day the template eventually gets
 * applied to (see `PlanningProgramService.applyToDate()` / `.generateOccurrences()`), which is
 * what lets the same template repeat indefinitely across different real dates.
 */
export class CreateProgramEntryDto {

    /**
     * Category of the templated item (e.g. TASK, EVENT, SHIFT...).
     * Must match a valid value defined in the `PlanningItemType` Prisma enum.
     */
    @IsEnum(PlanningItemType)
    type!: PlanningItemType;

    /**
     * Title of the recurring item (e.g. "Entraînement jambes", "Cours de mathématiques").
     */
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title!: string;

    /**
     * Optional free-text description/notes for this recurring item.
     */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    /**
     * Optional start clock time, "HH:mm" (24h), e.g. "09:00".
     * Time slots are entirely optional per the user's requirement - a program can stay purely
     * "day-level" (no hours at all) if that's all that's needed.
     */
    @IsOptional()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'startTime must be in HH:mm 24h format (e.g. "09:00").',
    })
    startTime?: string;

    /**
     * Optional end clock time, "HH:mm" (24h), e.g. "12:00".
     */
    @IsOptional()
    @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
        message: 'endTime must be in HH:mm 24h format (e.g. "12:00").',
    })
    endTime?: string;

    /**
     * Optional explicit display/application order within the same day, for when several
     * entries share that day (e.g. two training blocks on the same Monday).
     */
    @IsOptional()
    @IsInt()
    @Min(0)
    order?: number;
}
