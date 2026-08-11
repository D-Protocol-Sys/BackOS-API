import { IsArray, ArrayNotEmpty, IsString } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when replacing the entire set of permissions 
 * associated with a specific role.
 */
export class ReplaceRolePermissionsDto {

    /**
     * An array of permission identifier strings that will overwrite the existing permissions of the role.
     * Must be a non-empty array where every element is a valid string (e.g., `["USER_READ", "USER_WRITE"]`).
     */
    @IsArray()
    @ArrayNotEmpty()
    @IsString({ each: true })
    permissionKeys!: string[];

}