import { IsString, MinLength, MaxLength } from 'class-validator';

/**
 * Data Transfer Object (DTO) used when broadcasting or sending a chat message.
 * Enforces text character constraints to ensure payload validity and guard against database overflow.
 */
export class SendMessageDto {
    /**
     * The text content of the message.
     * Required field: must be a non-empty string between 1 and 4000 characters in length.
     */
    @IsString()
    @MinLength(1)
    @MaxLength(4000)
    content!: string;
}