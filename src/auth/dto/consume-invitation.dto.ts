import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * Data Transfer Object representing the payload required to consume/validate an invitation token and verification code.
 */
export class ConsumeInvitationDto {
    /**
     * Unique secure invitation token delivered via the invitation link.
     */
    @ApiProperty({
        description: 'The secure invitation token sent to the user via email link.',
        example: 'a1b2c3d4-e5f6-7890-1234-56789abcdef0',
    })
    @IsString()
    token!: string;

    /**
     * 6-character/digit verification code associated with the invitation.
     */
    @ApiProperty({
        description: 'The 6-character/digit verification code sent alongside the invitation.',
        example: '123456',
        minLength: 6,
        maxLength: 6,
    })
    @IsString()
    @Length(6, 6)
    code!: string;
}
