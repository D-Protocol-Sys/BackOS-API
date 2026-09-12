import {
    IsString, IsOptional, MinLength, MaxLength, IsInt, Min, Max,
    IsArray, ValidateNested, ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateProgramWeekDto } from './create-program-week.dto';

/**
 * Data Transfer Object (DTO) for creating a new `PlanningProgram` - the recurring "template"
 * (e.g. "Sport", "Cours") that will later be projected onto the real, dated planning.
 *
 * The full week/day/entry tree can optionally be provided in one call (matches "je clique sur
 * créer, je donne le nom, je remplis lundi/mardi/..." in one go), or the program can be created
 * empty first and filled/extended week by week afterwards via the dedicated week endpoints
 * (matches "j'ajoute une nouvelle semaine plus tard").
 */
export class CreatePlanningProgramDto {

    /**
     * Display name of the program (e.g. "Sport", "Cours").
     */
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    name!: string;

    /**
     * Optional free-text description of the program.
     */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    /**
     * Number of distinct weeks in the repeating cycle before it loops back to week 0.
     * Defaults to 1 (the simplest case: the exact same week repeats every week).
     * A program spanning "2 semaines" / "3 semaines" sets this to 2 / 3, etc.
     */
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(52)
    cycleWeeks?: number;

    /**
     * IANA timezone identifier used to resolve which calendar day a given moment falls on.
     * Defaults to Europe/Paris (same default as `Planning.timezone`).
     */
    @IsOptional()
    @IsString()
    @MaxLength(100)
    timezone?: string;

    /**
     * Optional full week/day/entry tree, provided upfront in a single request.
     * Additional weeks can always be appended later via `PUT .../weeks/:weekIndex`.
     */
    @IsOptional()
    @IsArray()
    @ArrayMaxSize(52)
    @ValidateNested({ each: true })
    @Type(() => CreateProgramWeekDto)
    weeks?: CreateProgramWeekDto[];
}
