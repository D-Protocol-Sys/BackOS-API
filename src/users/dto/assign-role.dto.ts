import { IsUUID } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when assigning a specific role to a user.
 */
export class AssignRoleDto {
    /**
     * The unique identifier (UUID v4) of the role to be assigned.
     * Enforces strict UUID format validation using `class-validator`.
     */
    @IsUUID()
    roleId!: string;
}