import { IsOptional, IsString, IsUUID, MinLength, MaxLength } from 'class-validator';

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

    /**
     * COMPLETENESS FIX: `Message.replyToId` has always existed in the schema (and the frontend
     * already renders a reply preview via `msg.replyTo`), but this DTO never exposed it as an
     * input, so the reply relationship could never actually be set. Optional ID of the message
     * being replied to, within the same conversation.
     */
    @IsOptional()
    @IsUUID()
    replyToId?: string;
}
