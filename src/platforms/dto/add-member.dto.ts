import { IsUUID, IsEnum } from 'class-validator';
import { PlatformRole } from '@prismamodels/client';

/**
 * Data Transfer Object (DTO) used when adding a new member to a platform 
 * or assigning specific access roles (e.g., ADMIN, MEMBER, VIEWER).
 */
export class AddMemberDto {
    /**
     * The unique identifier (UUID v4) of the target user to add.
     * Enforces strict UUID validation using `class-validator`.
     */
    @IsUUID()
    userId!: string;

    /**
     * The platform-level role assigned to the user.
     * Validates that the input value strictly matches an allowed enum value from `PlatformRole`.
     */
    @IsEnum(PlatformRole)
    role!: PlatformRole;
}