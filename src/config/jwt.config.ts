import { registerAs } from '@nestjs/config';

/**
 * JWT (JSON Web Token) Configuration Namespace ('jwt')
 * * Groups all authentication token settings into a dedicated namespace.
 * Accessible via `ConfigService.get('jwt.property')`.
 */
export default registerAs('jwt', () => ({

    /**
     * Secret key used to sign and verify JWT access tokens.
     * MUST be kept secret and should be a long, random string in production.
     * * Note: Uses a fallback to prevent runtime crashes if missing in development.
     */
    secret: process.env.JWT_SECRET,

    /**
     * Expiration duration for short-lived JWT access tokens (e.g., '15m', '1h', '1d').
     * * Fallback: Checks `JWT_ACCESS_EXPIRES_IN` first (from .env), then defaults to '15m'.
     */
    expiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? process.env.JWT_EXPIRES_IN ?? '15m',

    /**
     * Validity duration for long-lived Refresh Tokens, expressed in days.
     * Used to calculate expiration dates when issuing new refresh session tokens.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 7 days
     */
    refreshTokenExpiresInDays: parseInt(
        process.env.REFRESH_TOKEN_EXPIRES_IN_DAYS ?? '7',
        10,
    ),

}));