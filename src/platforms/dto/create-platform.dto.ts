import { IsString, IsOptional, IsUrl, MinLength, MaxLength } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when creating a new platform entity.
 * Defines input properties and validation constraints for incoming HTTP requests.
 */
export class CreatePlatformDto {
    /**
     * The name of the platform.
     * Required field: must be a string between 2 and 100 characters in length.
     */
    @IsString()
    @MinLength(2)
    @MaxLength(100)
    name!: string;

    /**
     * An optional summary or details describing the platform.
     * Optional field: if provided, must be a string up to 500 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(500)
    description?: string;

    /**
     * An optional web URL associated with the platform.
     * Optional field: if provided, must be a valid URL format.
     * `require_tld: false` allows local development URLs (e.g., `http://localhost:3000`).
     */
    @IsOptional()
    @IsUrl({ require_tld: false })
    url?: string;
}
