import { IsString, Length } from 'class-validator';

/**
 * Data Transfer Object for `DELETE /users/me`.
 *
 * SECURITY FIX (audit #3 - elevated): previously this route took no body at all - a valid
 * access token alone was enough to permanently delete the caller's account. It now requires a
 * fresh 6-digit TOTP code as "step-up" re-authentication, verified by
 * `AuthService.verifyStepUpTotp()` before `UsersService.hardDeleteUser()` is ever called. See
 * `UsersService.deleteOwnAccount()` for the full rationale.
 */
export class DeleteOwnAccountDto {

    /**
     * A freshly-generated 6-digit TOTP code from the user's authenticator app, proving current
     * possession of their MFA device (not their original login code, which may be minutes old).
     */
    @IsString()
    @Length(6, 6)
    totpCode!: string;

}
