import { IsInt, Min, IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProgramDayDto } from './create-program-day.dto';

/**
 * Data Transfer Object (DTO) describing one week within a `PlanningProgram` cycle.
 *
 * `weekIndex` is 0-based and only meaningful modulo `PlanningProgram.cycleWeeks`: it is what
 * lets two different Fridays (week A vs week B of an alternating program) carry different
 * content - see `PlanningProgramService`'s cycle-resolution helpers.
 */
export class CreateProgramWeekDto {

    /**
     * 0-based position of this week inside the program's cycle (0 = first week, 1 = second
     * week, etc.). Must stay below the program's `cycleWeeks`.
     */
    @IsInt()
    @Min(0)
    weekIndex!: number;

    /**
     * The days configured for this week. Only the days that actually have something planned
     * need to be included (e.g. only Monday/Wednesday/Saturday for a 3-day-a-week program).
     */
    @IsArray()
    @ArrayMaxSize(7)
    @ValidateNested({ each: true })
    @Type(() => CreateProgramDayDto)
    days!: CreateProgramDayDto[];
}
