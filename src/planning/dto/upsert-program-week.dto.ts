import { IsArray, ValidateNested, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProgramDayDto } from './create-program-day.dto';

/**
 * Data Transfer Object (DTO) used to create or fully replace one week of a `PlanningProgram`
 * (`PUT /.../programs/:id/weeks/:weekIndex`). The target `weekIndex` itself is taken from the
 * route parameter, not the body - see `PlanningProgramService.upsertWeek()`.
 *
 * This is an upsert at the *week* level: the days provided here fully replace whatever that
 * week previously contained (matches "j'ajoute une nouvelle semaine et je remplis le nombre de
 * jours qu'il me faut" - only the days actually used need to be sent).
 */
export class UpsertProgramWeekDto {
    /**
     * The days configured for this week (only the days that have something planned).
     */
    @IsArray()
    @ArrayMaxSize(7)
    @ValidateNested({ each: true })
    @Type(() => CreateProgramDayDto)
    days!: CreateProgramDayDto[];
}
