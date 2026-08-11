import { IsString, MinLength, MaxLength, IsOptional, IsArray, ArrayNotEmpty, IsString as IsStringEach, IsInt, Min } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when creating a custom user role.
 * Defines input payload validation rules for role metadata, hierarchy levels, 
 * and associated permission keys.
 */
export class CreateRoleDto {

    /**
     * The unique name of the role (e.g., "Project Manager").
     * Required field: must be a string between 2 and 50 characters in length.
     */
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    name!: string;

    /**
     * An optional summary or description explaining the role's scope.
     * Optional field: if provided, must be a string up to 255 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(255)
    description?: string;

    /**
     * The hierarchical level associated with the role (used for precedence/permission checks).
     * Must be an integer greater than or equal to 1.
     */
    @IsInt()
    @Min(1)
    level!: number;

    /**
     * An array of permission identifier strings assigned to this role (e.g., `["USER_READ", "USER_WRITE"]`).
     * Must be a non-empty array containing valid string elements.
     */
    @IsArray()
    @ArrayNotEmpty()
    @IsStringEach({ each: true })
    permissionKeys!: string[];
    
}