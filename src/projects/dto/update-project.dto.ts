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
    ValidateIf,
} from 'class-validator';
import { ProjectStatus } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) used when partially updating an existing project.
 * All properties are optional to allow flexible partial updates (PATCH requests).
 */
export class UpdateProjectDto {

    /**
     * An optional updated name for the project.
     * Optional field: if provided, must be a string between 2 and 150 characters in length.
     */
    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(150)
    name?: string;

    /**
     * An optional updated description for the project.
     * Optional field: if provided, must be a string up to 2000 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(2000)
    description?: string;

    /**
     * An optional updated status. Setting this to `COMPLETED` automatically stamps
     * `completedAt` in the service layer (unless a value was already set); moving away from
     * `COMPLETED` clears it back out. See `ProjectsService.update()`.
     */
    @IsOptional()
    @IsEnum(ProjectStatus)
    status?: ProjectStatus;

    /**
     * An optional updated platform link. Send `null` explicitly to detach the project from
     * any platform.
     */
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsUUID()
    platformId?: string | null;

    /**
     * An optional updated manager. Send `null` explicitly to unassign the project.
     */
    @IsOptional()
    @ValidateIf((_, value) => value !== null)
    @IsUUID()
    managerId?: string | null;

    /**
     * An optional updated planned start date, as an ISO-8601 date/datetime string.
     */
    @IsOptional()
    @IsDateString()
    startAt?: string;

    /**
     * An optional updated target/expected end date, as an ISO-8601 date/datetime string.
     */
    @IsOptional()
    @IsDateString()
    targetEndAt?: string;

    /**
     * An optional updated manual priority ranking (0-10, higher = more important).
     */
    @IsOptional()
    @IsInt()
    @Min(0)
    @Max(10)
    priority?: number;

}
