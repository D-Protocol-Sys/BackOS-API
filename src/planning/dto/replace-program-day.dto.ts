import { IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProgramEntryDto } from './create-program-entry.dto';

/**
 * Data Transfer Object (DTO) used to fully replace the entries of a single day within an
 * existing program week (`PUT /.../weeks/:weekIndex/days/:dayOfWeek`), without having to
 * resend the other days of that week. Useful to add optional hours to a day after the fact,
 * or to change just one day's content (e.g. next week's Monday workout changes).
 */
export class ReplaceProgramDayDto {
    /**
     * The recurring items scheduled on this day (can be empty to clear the day).
     */
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => CreateProgramEntryDto)
    entries!: CreateProgramEntryDto[];
}
