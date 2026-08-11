import {
    IsString, IsEnum, IsOptional, IsBoolean, IsInt, Min, MinLength, MaxLength,
} from 'class-validator';
import { FieldType } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) defining the schema and validation rules 
 * for creating a new field/column within a dynamic entity.
 */
export class CreateFieldDto {

    /**
     * Name/label of the field (e.g., "Email", "Age", "First Name").
     * Enforces type safety, mandatory presence, and character length bounds.
     * * `@IsString()` - Ensures input value is a valid primitive string.
     * `@MinLength(1)` - Prevents empty strings `""` or whitespace-only inputs.
     * `@MaxLength(60)` - Caps length at 60 characters to align with database column limits.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name!: string;

    /**
     * Data type of the field (e.g., STRING, NUMBER, BOOLEAN, DATE, ENUM).
     * Enforces strict type validation against the Prisma-generated `FieldType` enum.
     * * `@IsEnum(FieldType)` - Rejects any string value that does not match an allowed enum option.
     */
    @IsEnum(FieldType)
    type!: FieldType;

    /**
     * Optional flag indicating whether this field is mandatory for entity records.
     * * `@IsOptional()` - Allows the client to omit this property (defaults to optional/nullable field).
     * `@IsBoolean()` - Ensures value is a strict boolean (`true` or `false`).
     */
    @IsOptional()
    @IsBoolean()
    required?: boolean;

    /**
     * Optional flag enforcing a UNIQUE constraint on the database column level.
     * * `@IsOptional()` - Field can be omitted.
     * `@IsBoolean()` - Ensures strict boolean validation.
     */
    @IsOptional()
    @IsBoolean()
    unique?: boolean;

    /**
     * Optional default value assigned automatically when creating new entity records.
     * * `@IsOptional()` - Allows omitting a default value.
     * `@IsString()` - Ensures string representation.
     * `@MaxLength(255)` - Limits length to fit standard database default column constraints.
     */
    @IsOptional()
    @IsString()
    @MaxLength(255)
    defaultValue?: string;

    /**
     * Optional flexible JSON metadata store for extended field configuration 
     * (e.g., UI select options, regex validation rules, or display masks).
     * * `@IsOptional()` - Field is optional.
     */
    @IsOptional()
    config?: Record<string, unknown>;
}