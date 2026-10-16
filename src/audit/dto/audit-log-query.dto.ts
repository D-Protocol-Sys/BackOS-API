import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Data Transfer Object (DTO) used to validate and transform
 * incoming query parameters for retrieving audit logs.
 */
export class AuditLogQueryDto {
    /**
     * Optional 'limit' parameter to control pagination/result size.
     * * @IsOptional() - Allows the field to be omitted without failing validation.
     * @Type(() => Number) - Automatically converts incoming HTTP query string values (e.g., "50") to a JavaScript number.
     * @IsInt() - Ensures the converted value is a valid integer (no decimals allowed).
     * @Min(1) - Enforces a minimum value of 1 to prevent invalid or negative limit requests.
     * @Max(500) - Caps the maximum number of records per request to 500 to protect server performance and memory.
     */
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(500)
    limit?: number;
}
