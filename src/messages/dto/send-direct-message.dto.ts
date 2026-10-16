import { IsOptional, IsString, IsUUID, MinLength, MaxLength } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when sending a direct message to a user or channel.
 * Enforces text string constraints to prevent empty messages or database overflow.
 */
export class SendDirectMessageDto {
    /**
     * The body content of the direct message.
     * Must be a non-empty string between 1 and 4000 characters in length.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(4000)
    content!: string;

    /** COMPLETENESS FIX: see the identical field on `SendMessageDto` for the full rationale. */
    @IsOptional()
    @IsUUID()
    replyToId?: string;
}
