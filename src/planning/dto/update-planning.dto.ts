import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreatePlanningDto } from './create-planning.dto';

export class UpdatePlanningDto extends PartialType(
    OmitType(CreatePlanningDto, ['scope'] as const),
) {}