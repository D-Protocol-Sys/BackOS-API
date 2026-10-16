// dto/change-status.dto.ts
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { StatusChangeReason } from '@prismamodels/enums';

/**
 * Data Transfer Object (DTO) used when changing an account's active or administrative status
 * (e.g., suspending, deactivating, or reactivating a user).
 */
export class ChangeUserStatusDto {
    /**
     * The categorized reason triggering the status change.
     * Enforces that the input value strictly matches an allowed enum option from `StatusChangeReason`.
     */
    @IsEnum(StatusChangeReason)
    reason!: StatusChangeReason;

    /**
     * An optional detailed explanation or administrative note regarding the status update.
     * Optional field: if provided, must be a string up to 500 characters.
     */
    @IsOptional()
    @IsString()
    @MaxLength(500)
    comment?: string;
}
