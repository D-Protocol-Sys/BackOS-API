import { registerAs } from '@nestjs/config';

/**
 * TOTP / One-Time Password (OTP) Configuration Namespace ('totp')
 * * Groups all settings related to temporary security verification codes,
 * rate limiting attempts, and code hashing configuration.
 * Accessible via `ConfigService.get('totp.property')`.
 */
export default registerAs('totp', () => ({
    /**
     * The cost factor / number of salt rounds used by bcrypt for hashing short OTP codes.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 12
     */
    saltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '12', 10),

    /**
     * Validity duration for generated OTP / TOTP codes, expressed in minutes.
     * Codes evaluated after this period will be rejected as expired.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 10 minutes
     */
    expiresInMinutes: parseInt(process.env.OTP_EXPIRES_IN_MINUTES ?? '10', 10),

    /**
     * Maximum allowed failed attempts before invalidating the active OTP session.
     * Prevents brute-force attacks against short numeric verification codes.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 5 attempts
     */
    invitationMaxAttempts: parseInt(process.env.INVITATION_MAX_ATTEMPTS ?? '5', 10),

    /**
     * Validity duration for generated invitation, expressed in Hours.
     * Invitation evaluated after this period will be rejected as expired.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 48 hours
     */
    invitationExpiresInHours: parseInt(process.env.INVITATION_EXPIRES_IN_HOURS ?? '48', 10),
}));
