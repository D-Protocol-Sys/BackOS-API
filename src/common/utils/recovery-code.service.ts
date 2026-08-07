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
     * * Format: `XXXX-XXXX` (8 uppercase hexadecimal characters split by a hyphen).
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
     * * @param rawCode - Plain text recovery code provided by the user or generator (e.g., `A1B2-C3D4`).
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
     * Helper method to generate a single 8-character recovery code formatted as `XXXX-XXXX`.
     * * Uses Node.js `randomBytes` for strong cryptographic randomness.
     * * @returns Formatted recovery code string (e.g., `E4F2-9A0B`).
     */
    private generateOne(): string {
        // Generate 4 random bytes (8 hex characters)
        const hex = randomBytes(4).toString('hex').toUpperCase(); 

        // Split into two 4-character blocks separated by a hyphen
        return `${hex.slice(0, 4)}-${hex.slice(4)}`;
    }
}