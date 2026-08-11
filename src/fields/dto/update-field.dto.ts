import {
    IsString, IsEnum, IsOptional, IsBoolean, MinLength, MaxLength,
} from 'class-validator';
import { FieldType } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) defining the schema and validation rules 
 * for updating an existing field/column within a dynamic entity.
 */
export class UpdateFieldDto {

    /**
     * Optional updated name/label for the field (e.g., "Primary Email").
     * * `@IsOptional()` - Allows partial updates; field can be omitted if unchanged.
     * `@IsString()` - Ensures input value is a valid primitive string.
     * `@MinLength(1)` - Prevents empty strings `""` or whitespace-only inputs.
     * `@MaxLength(60)` - Caps length at 60 characters to align with database column limits.
     */
    @IsOptional()
    @IsString()
    @MinLength(1)
    @MaxLength(60)
    name?: string;

    /**
     * Optional updated data type for the field (e.g., changing from STRING to TEXT).
     * * `@IsOptional()` - Field can be omitted.
     * `@IsEnum(FieldType)` - Enforces strict validation against allowed Prisma `FieldType` enum values.
     */
    @IsOptional()
    @IsEnum(FieldType)
    type?: FieldType;

    /**
     * Optional flag to modify mandatory requirement for entity records.
     * * `@IsOptional()` - Field can be omitted.
     * `@IsBoolean()` - Ensures strict boolean validation (`true` or `false`).
     */
    @IsOptional()
    @IsBoolean()
    required?: boolean;

    /**
     * Optional flag to toggle a UNIQUE database constraint on the field.
     * * `@IsOptional()` - Field can be omitted.
     * `@IsBoolean()` - Ensures strict boolean validation (`true` or `false`).
     */
    @IsOptional()
    @IsBoolean()
    unique?: boolean;

    /**
     * Optional updated default value assigned to newly created entity records.
     * * `@IsOptional()` - Field can be omitted.
     * `@IsString()` - Ensures string representation.
     * `@MaxLength(255)` - Limits length to fit standard database default column constraints.
     */
    @IsOptional()
    @IsString()
    @MaxLength(255)
    defaultValue?: string;

    /**
     * Optional updated flexible JSON metadata store for extended field configuration 
     * (e.g., updated select options, validation rules, or UI masks).
     * * `@IsOptional()` - Field can be omitted.
     */
    @IsOptional()
    config?: Record<string, unknown>;
    
}