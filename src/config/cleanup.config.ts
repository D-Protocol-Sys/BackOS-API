import { registerAs } from '@nestjs/config';

/**
 * Data Cleanup & Retention Policy Configuration Namespace ('cleanup')
 * * Configures retention thresholds (in days) used by background CRON jobs 
 * to purge expired database entries (e.g., old OTPs, stale refresh tokens).
 * Accessible via `ConfigService.get('cleanup.property')`.
 */
export default registerAs('cleanup', () => ({

    /**
     * Number of days to retain expired OTP records before permanently deleting them.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 7 days
     */
    otpRetentionDays: parseInt(
        process.env.OTP_CLEANUP_RETENTION_DAYS ?? '7',
        10,
    ),

    /**
     * Number of days to retain revoked or expired Refresh Tokens before purging.
     * `parseInt` converts the environment string into a base-10 integer.
     * * Fallback: 30 days
     */
    refreshTokenRetentionDays: parseInt(
        process.env.REFRESH_TOKEN_CLEANUP_RETENTION_DAYS ?? '30',
        10,
    ),

}));