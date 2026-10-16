import { IsString } from 'class-validator';

/**
 * Data Transfer Object (DTO) used to validate incoming requests
 * when a user attempts to validate an invitation link or code.
 */
export class ValidateInvitationDto {
    /**
     * The unique invitation token (usually extracted from a URL parameter or body).
     * * @IsString() - Ensures the incoming token is strictly a string primitive.
     * Prevents type pollution and injection attacks by rejecting non-string payloads.
     * * Note on `!:` (Definite Assignment Operator):
     * Assures the TypeScript compiler that this property will be assigned at runtime
     * by NestJS validation pipes, satisfying strict initialization rules.
     */
    @IsString()
    token!: string;
}
