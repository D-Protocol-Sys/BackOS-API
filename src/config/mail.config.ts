import { registerAs } from '@nestjs/config';

/**
 * Mail / SMTP Configuration Namespace ('mail')
 * * Groups all Email and Transport Layer Security (SMTP) settings
 * into a dedicated namespace.
 * Accessible via `ConfigService.get('mail.property')`.
 */
export default registerAs('mail', () => ({
    /**
     * The hostname or IP address of the SMTP server.
     */
    host: process.env.SMTP_HOST,

    /**
     * The network port used by the SMTP server.
     */
    port: parseInt(process.env.SMTP_PORT ?? '587', 10),

    /**
     * Indicates whether the connection should use explicit SSL/TLS encryption.
     * - `true`: Connects securely via SSL/TLS on port 465.
     * - `false`: Connects unencrypted or via STARTTLS on ports 587 / 2525.
     * * Evaluates string comparison `=== 'true'` to safely produce a boolean.
     */
    secure: process.env.SMTP_SECURE === 'true',

    /**
     * The username or API key required for SMTP authentication.
     */
    user: process.env.SMTP_USER,

    /**
     * The password or API secret key required for SMTP authentication.
     */
    password: process.env.SMTP_PASSWORD,

    /**
     * Default "From" email address and display name used in outgoing emails.
     * Format: "Display Name <email@example.com>"
     */
    from: process.env.SMTP_FROM,
}));
