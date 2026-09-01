import { Injectable } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';

/**
 * Utility service dedicated to generating and hashing emergency account recovery codes.
 * * Recovery codes serve as single-use backup authentication factors when a user loses access to their TOTP device.
 */
@Injectable()
export class RecoveryCodeService {

    /**
     * Generates a unique list of cryptographically secure recovery codes.
     * * Format: `XXXX-XXXX-XXXX-XXXX` (16 uppercase hexadecimal characters split into four blocks).
     * * Utilizes a `Set` internally to guarantee all returned codes in the batch are unique.
     * * @param count - The total number of unique recovery codes to generate (defaults to 10).
     * @returns Array of plain text recovery code strings.
     */
    generate(count = 10): string[] {
        const codes = new Set<string>();

        while (codes.size < count) {
            codes.add(this.generateOne());
        }

        return Array.from(codes);
    }

    /**
     * Computes a deterministic SHA-256 cryptographic hash of a raw recovery code.
     * * Ensures raw recovery codes are never stored in plain text in the database.
     * Normalizes the code to uppercase before hashing to prevent case-sensitivity mismatches.
     * * @param rawCode - Plain text recovery code provided by the user or generator (e.g., `A1B2-C3D4-E5F6-0718`).
     * @returns The SHA-256 hash string in hexadecimal format.
     */
    hashRecoveryCode(rawCode: string): string {
        // Normalize input by trimming spaces and converting to uppercase
        const normalized = rawCode.trim().toUpperCase();

        return createHash('sha256')
            .update(normalized)
            .digest('hex');
    }

    /**
     * Helper method to generate a single recovery code formatted as `XXXX-XXXX-XXXX-XXXX`.
     * * Uses Node.js `randomBytes` for strong cryptographic randomness.
     *
     * SECURITY FIX: the previous version generated only 4 random bytes (32 bits of entropy,
     * ~4.3 billion combinations). While the code is single-use and only exploitable if the
     * hash database leaks, 32 bits is well below current practice for a standalone secret -
     * an unsalted SHA-256 hash of a 32-bit space can be brute-forced offline in seconds on
     * commodity GPU hardware. We now generate 8 random bytes (64 bits of entropy,
     * ~1.8 * 10^19 combinations), which is comfortably outside the range of realistic offline
     * brute-force, in line with recovery-code lengths used by major identity providers.
     * * @returns Formatted recovery code string (e.g., `E4F2-9A0B-11CE-77AD`).
     */
    private generateOne(): string {
        // Generate 8 random bytes (16 hex characters / 64 bits of entropy)
        const hex = randomBytes(8).toString('hex').toUpperCase();

        // Split into four 4-character blocks separated by hyphens for readability
        return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`;
    }
}