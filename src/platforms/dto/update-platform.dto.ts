import { IsString, IsOptional, IsUrl, MinLength, MaxLength } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when partially updating an existing platform entity.
 * All properties are optional to allow flexible partial updates (PATCH requests).
 */
export class UpdatePlatformDto {

    /**
     * An optional updated name for the platform.
     * Optional field: if provided, must be a string between 2 and 100 characters in length.
     */
    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(100)
    name?: string;

    /**
     * An optional updated summary or details describing the platform.
     * Optional field: if provided, must be a string up to 500 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    /**
     * An optional updated web URL associated with the platform.
     * Optional field: if provided, must be a valid URL format.
     * `require_tld: false` allows local development URLs (e.g., `http://localhost:3000`).
     */
    @IsOptional()
    @IsUrl({ require_tld: false })
    url?: string;
    
}