import { IsUUID } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when assigning a user to a resource
 * (e.g., assigning a team member to a project or task).
 */
export class AddAssigneeDto {
    /**
     * The unique identifier (UUID v4) of the target user to assign.
     * Enforces strict UUID validation using `class-validator` rules.
     */
    @IsUUID()
    userId!: string;
}
