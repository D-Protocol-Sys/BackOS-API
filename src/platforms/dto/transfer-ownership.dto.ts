import { IsUUID } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when transferring administrative ownership 
 * of a platform, workspace, or resource to another user.
 */
export class TransferOwnershipDto {

    /**
     * The unique identifier (UUID v4) of the user designated as the new owner.
     * Enforces strict UUID format validation using `class-validator`.
     */
    @IsUUID()
    newOwnerId!: string;

}