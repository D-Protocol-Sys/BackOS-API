import { IsString, IsObject } from 'class-validator';

/**
 * Data Transfer Object (DTO) defining the schema and validation rules 
 * for enabling a platform service/feature module alongside its configuration payload.
 */
export class EnableServiceDto {

    /**
     * Unique identifier key of the target service (e.g., "scheduler", "auth-user", "storage").
     * Enforces mandatory presence and string data type.
     * * `@IsString()` - Ensures input value is a valid primitive string.
     */
    @IsString()
    serviceKey!: string;

    /**
     * Service-specific configuration key-value pairs 
     * (e.g., connection options, feature flags, or integration credentials).
     * Enforces mandatory presence and plain JavaScript object type validation.
     * * `@IsObject()` - Guarantees that the payload is a non-null JSON object.
     */
    @IsObject()
    config!: Record<string, unknown>;

}