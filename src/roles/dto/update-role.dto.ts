import { IsString, MinLength, MaxLength, IsOptional } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when partially updating role details.
 * All fields are optional to support flexible partial updates (PATCH requests).
 */
export class UpdateRoleDto {
    /**
     * An optional updated name for the role.
     * Optional field: if provided, must be a string between 2 and 50 characters in length.
     */
    @IsOptional()
    @IsString()
    @MinLength(2)
    @MaxLength(50)
    name?: string;

    /**
     * An optional updated description explaining the role's purpose.
     * Optional field: if provided, must be a string up to 255 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(255)
    description?: string;
}
