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

}));