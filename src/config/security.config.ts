import { registerAs } from '@nestjs/config';

/**
 * Application Security & Cryptography Configuration Namespace ('security')
 * * Holds master encryption keys used for encrypting sensitive fields in the database 
 * (e.g., AES-256-GCM secret keys for 2FA/MFA).
 * Accessible via `ConfigService.get('security.property')`.
 */
export default registerAs('security', () => ({

    /**
     * 256-bit Hexadecimal Encryption Key used for AES symmetric encryption.
     * MUST be exactly 64 hex characters (32 bytes) in production.
     */
    encryptionKey: process.env.ENCRYPTION_KEY,

    /**
     * Login brute-force protection settings.
     *
     * WHY THIS EXISTS: the invitation-consumption flow already limited failed attempts
     * (`Invitation.attempts` / `maxAttempts`), but the day-to-day `POST /auth/login` endpoint
     * previously relied solely on the global IP-based rate limiter (20 requests/minute,
     * shared with the entire API) to slow down brute-force attempts against a user's TOTP
     * code. That is not sufficient on its own - a distributed attacker rotating source IPs
     * is not slowed down by a per-IP limiter at all. These settings drive a *per-account*
     * lockout implemented in `AuthService.login()`, which is a second, independent layer of
     * defense that does not depend on the attacker's IP address.
     */
    loginLockout: {
        /** Number of consecutive failed login attempts allowed before the account is locked. */
        maxAttempts: parseInt(process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS ?? '5', 10),

        /** Duration (in minutes) an account stays locked once the threshold above is reached. */
        lockoutMinutes: parseInt(process.env.LOGIN_LOCKOUT_MINUTES ?? '15', 10),
    },

}));