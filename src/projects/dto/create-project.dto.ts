import {
    IsString,
    IsOptional,
    IsUUID,
    IsEnum,
    IsInt,
    IsDateString,
    MinLength,
    MaxLength,
    Min,
    Max,
} from 'class-validator';
import { ProjectStatus } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) used when creating a new project (a product/feature idea
 * someone intends to build and sell).
 *
 * Only `name` is required - everything else (description, dates, platform link, manager,
 * priority) is optional so a project can be created the moment an idea exists, and fleshed
 * out later via `UpdateProjectDto`.
 */
export class CreateProjectDto {

    /**
     * The name of the project (e.g. "Online course platform").
     * Required field: must be a string between 2 and 150 characters in length.
     */
    @IsString()
    @MinLength(2)
    @MaxLength(150)
    name!: string;

    /**
     * A free-text description of what the project is about.
     * Optional field: if provided, must be a string up to 2000 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    /**
     * Optional initial status. Defaults to `PLANNED` in the service layer when omitted -
     * most projects start as an idea before any work begins.
     */
    @IsOptional()
    @IsEnum(ProjectStatus)
    status?: ProjectStatus;

    /**
     * Optional platform (generated backend) this project is meant to be built and delivered
     * on. A project does NOT need a platform - it can exist purely as an idea, or be delivered
     * outside of BPG entirely (e.g. a physical product).
     */
    @IsOptional()
    @IsUUID()
    platformId?: string;

    /**
     * Optional manager for this project. Defaults to the creating user in the service layer
     * when omitted, so every project has a clear point of contact unless explicitly cleared
     * later via `UpdateProjectDto`.
     */
    @IsOptional()
    @IsUUID()
    managerId?: string;

    /**
     * Optional planned start date, as an ISO-8601 date/datetime string.
     */
    @IsOptional()
    @IsDateString()
    startAt?: string;

    /**
     * Optional target/expected end date, as an ISO-8601 date/datetime string.
     * Validated against `startAt` (when both are provided) in the service layer.
     */
    @IsOptional()
    @IsDateString()
    targetEndAt?: string;

    /**
     * Optional manual priority ranking. Higher means more important.
     * Bounded to a small, human-friendly range (0-10) to keep sorting/filtering meaningful.
     */
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10)
    priority?: number;

}
