import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreatePlanningProgramDto } from './create-planning-program.dto';

/**
 * Data Transfer Object (DTO) for updating a `PlanningProgram`'s top-level fields.
 *
 * `weeks` is intentionally excluded: the week/day/entry tree is managed through its own
 * dedicated endpoints (`PUT/DELETE .../weeks/:weekIndex`, `PUT .../weeks/:weekIndex/days/:day`)
 * so that adding a new week never requires resending the entire program.
 */
export class UpdatePlanningProgramDto extends PartialType(
    OmitType(CreatePlanningProgramDto, ['weeks'] as const),
) {}
