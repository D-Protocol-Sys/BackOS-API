import { IsString, IsUUID, Length, Matches } from 'class-validator';

/**
 * Body of `POST /internal/generated-auth/verify`, sent by a GENERATED BACKEND (never by a browser)
 * when someone logs in there with their BackOS username + authenticator code.
 */
export class VerifyInternalLoginDto {
    /**
     * BackOS id of the user trying to log in (the generated backend stores it on the internal
     * account it created for them).
     * * `@IsUUID()` - BackOS user ids are UUIDs.
     */
    @IsUUID()
    userId!: string;

    /**
     * The 6-digit authenticator code the person typed.
     * * `@Matches(/^[0-9]{6}$/)` - Same shape as the BackOS login `totpCode`.
     */
    @IsString()
    @Length(6, 6)
    @Matches(/^[0-9]{6}$/)
    totpCode!: string;
}
