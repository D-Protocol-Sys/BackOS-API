import { IsString, IsOptional, MinLength, MaxLength } from 'class-validator';

/**
 * Data Transfer Object (DTO) defining the schema and validation rules 
 * for creating a new entity record via incoming API payloads.
 */
export class CreateEntityDto {

    /**
     * Name attribute of the entity.
     * Enforces type safety, mandatory presence, and character length bounds.
     * * `@IsString()` - Ensures input value is a valid primitive string.
     * `@MinLength(1)` - Prevents empty strings `""` or whitespace-only inputs.
     * `@MaxLength(60)` - Prevents database truncation/overflow by capping length at 60 characters.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

}