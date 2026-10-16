import { IsEnum, IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { PlanningWeekDay } from '@prismamodels/client';
import { CreateProgramEntryDto } from './create-program-entry.dto';

/**
 * Data Transfer Object (DTO) describing one day of week within a `PlanningProgram` week cycle
 * (e.g. Monday's workout, Tuesday's course...). A program doesn't have to fill every day - a
 * "2 or 3 days a week" program (e.g. Monday/Wednesday/Saturday) simply omits the other days.
 */
export class CreateProgramDayDto {
    /**
     * Which day of the week this entry list applies to.
     */
    @IsEnum(PlanningWeekDay)
    dayOfWeek!: PlanningWeekDay;

    /**
     * The recurring items scheduled on this day (can be empty, or contain several items for
     * the same day, e.g. a morning course and an evening training session).
     */
    @IsArray()
    @ArrayMaxSize(50)
    @ValidateNested({ each: true })
    @Type(() => CreateProgramEntryDto)
    entries!: CreateProgramEntryDto[];
}
