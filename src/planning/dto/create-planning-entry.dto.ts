import {
    IsEnum, IsString, IsOptional, IsDateString, MinLength, MaxLength,
} from 'class-validator';
import { PlanningItemType, PlanningItemStatus } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) for creating a new planning entry.
 * Defines input payload validation constraints enforced at API runtime via `ValidationPipe`.
 */
export class CreatePlanningEntryDto {

    /**
     * Category or type classification of the planning entry (e.g., TASK, EVENT, MILESTONE).
     * Must match a valid value defined in the `PlanningItemType` Prisma enum.
     */
    @IsEnum(PlanningItemType)
    type!: PlanningItemType;

    /**
     * Primary title of the planning entry.
     * Enforces non-empty string input capped at a maximum of 200 characters.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(200)
    title!: string;

    /**
     * Optional detailed narrative or markdown description of the entry.
     * Capped at 2000 characters to prevent database bloat and excessive payload sizes.
     */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    /**
     * Optional starting timestamp for scheduled events or tasks.
     * Must be a valid ISO 8601 formatted date string (e.g., "2026-08-10T08:00:00.000Z").
     */
    @IsOptional()
    @IsDateString()
    startAt?: string;

    /**
     * Optional ending timestamp for scheduled events or tasks.
     * Must be a valid ISO 8601 formatted date string.
     */
    @IsOptional()
    @IsDateString()
    endAt?: string;

    /**
     * Optional strict hard deadline for task completion.
     * Must be a valid ISO 8601 formatted date string.
     */
    @IsOptional()
    @IsDateString()
    dueDate?: string;

    /**
     * Optional target objective completion date.
     * Useful for milestones or soft target tracking; must be a valid ISO 8601 date string.
     */
    @IsOptional()
    @IsDateString()
    targetDate?: string;

    /**
     * Optional lifecycle status (e.g., TODO, IN_PROGRESS, COMPLETED).
     * Must match a valid value from the `PlanningItemStatus` Prisma enum if provided.
     */
    @IsOptional()
    @IsEnum(PlanningItemStatus)
    status?: PlanningItemStatus;

}