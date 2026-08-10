import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreatePlanningEntryDto } from './create-planning-entry.dto';

/**
 * Data Transfer Object (DTO) for updating an existing planning entry.
 * Implements partial updates (PATCH) by leveraging NestJS mapped types utilities.
 *
 * Pattern Explanation:
 * 1. `OmitType(CreatePlanningEntryDto, ['type'] as const)`:
 * Removes the `type` property from the creation DTO because a planning entry's 
 * classification type is immutable once created.
 *
 * 2. `PartialType(...)`:
 * Makes all remaining fields optional while preserving their validation decorators 
 * (e.g., `@IsString()`, `@MaxLength()`). This enables flexible partial payload updates.
 */
export class UpdatePlanningEntryDto extends PartialType(
    OmitType(CreatePlanningEntryDto, ['type'] as const),
) {}