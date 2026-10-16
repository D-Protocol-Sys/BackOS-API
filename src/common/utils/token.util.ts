import { randomBytes, createHash } from 'crypto';

/**
 * Utility functions for cryptographic token operations.
 * * Used for generating secure, non-guessable tokens (invitations, refresh tokens)
 * and computing single-way SHA-256 hashes for secure database storage.
 */

/**
 * Generates a cryptographically secure random token string encoded in hexadecimal.
 * * Uses Node.js native `randomBytes` to ensure high entropy suitable for security tokens.
 * * @param bytes - Number of random bytes to generate (defaults to 32 bytes, producing a 64-character hex string).
 * @returns Cryptographically secure raw token string in hexadecimal format.
 */
export function generateSecureToken(bytes = 32): string {
    return randomBytes(bytes).toString('hex');
}

/**
 * Computes a deterministic SHA-256 cryptographic hash of a raw token.
 * * Used to ensure raw tokens (such as invitation or refresh tokens) are never stored in plain text.
 * * @param rawToken - Unhashed plain text token string.
 * @returns The resulting SHA-256 hash formatted as a 64-character hexadecimal string.
 */
export function hashToken(rawToken: string): string {
    return createHash('sha256').update(rawToken).digest('hex');
}
