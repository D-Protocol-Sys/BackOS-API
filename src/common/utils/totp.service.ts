import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { generateSecret, generateURI, verify } from 'otplib';

/**
 * Low-level utility service dedicated to Time-based One-Time Password (TOTP) operations.
 * * Acts as a wrapper around the `otplib` library to generate secrets, build OTP Auth URIs,
 * and verify time-sensitive verification tokens.
 */
@Injectable()
export class TotpService {
    constructor(private readonly configService: ConfigService) {}

    /**
     * Generates a new cryptographically secure base32 TOTP secret key.
     * * @returns A base32 encoded string representing the raw TOTP secret.
     */
    generateSecret(): string {
        return generateSecret();
    }

    /**
     * Constructs a standard `otpauth://` URI payload used to generate QR codes for authenticator apps.
     * * Retrieves the issuer name dynamically from `ConfigService` (`app.serverName`).
     * Format: `otpauth://totp/ISSUER:email?secret=...&issuer=ISSUER`
     * * @param email - User's account email used as the label in authenticator apps.
     * @param secret - Raw base32 TOTP secret key associated with the user account.
     * @returns The fully constructed OTP Auth URI string.
     */
    buildOtpauthUri(email: string, secret: string): string {
        // Retrieve server/app name from configuration with fallback
        const issuer = this.configService.get<string>('app.serverName', 'BACKOS');

        return generateURI({
            issuer,
            label: email,
            secret,
        });
    }

    /**
     * Validates a user-provided 6-digit TOTP token against their secret key.
     * * Checks whether the token is valid for the current time step (accounting for standard drift window).
     * * @param secret - The decrypted base32 TOTP secret key.
     * @param token - The 6-digit verification code entered by the user.
     * @returns Promise resolving to `true` if the token is valid and active, `false` otherwise.
     */
    async verify(secret: string, token: string): Promise<boolean> {
        return (await this.verifyWithStep(secret, token)).valid;
    }

    /**
     * Same as `verify()` but also returns the RFC 6238 time step the code belongs to, so callers
     * can reject a second use of the same code (SEC-009 anti-replay).
     */
    async verifyWithStep(secret: string, token: string): Promise<{ valid: boolean; timeStep?: number }> {
        const normalizedToken = token.trim().replace(/\s+/g, '');

        const result = await verify({
            secret,
            token: normalizedToken,
        });

        if (!result.valid) return { valid: false };
        return { valid: true, timeStep: (result as { timeStep?: number }).timeStep };
    }
}
