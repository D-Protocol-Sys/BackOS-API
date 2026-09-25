import { IsUUID } from 'class-validator';

/**
 * Body of `POST /internal/generated-auth/session-check`: asks whether a BackOS user may still
 * hold a session on a generated backend (no authenticator code involved).
 */
export class SessionCheckDto {
    @IsUUID()
    userId!: string;
}
