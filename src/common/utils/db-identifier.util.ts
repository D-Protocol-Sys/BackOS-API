import * as crypto from 'crypto';
import { toSqlIdentifier } from './sql-identifier.util';

/**
 * Retrieves and sanitizes the system environment prefix used for naming databases and roles.
 * Defaults to 'app' if SERVER_NAME or DB_PREFIX is not configured in environment variables.
 * * @returns A safe, SQL-compliant prefix string.
 */
function getSanitizedPrefix(): string {
    const rawPrefix = process.env.SERVER_NAME || 'app';
    return toSqlIdentifier(rawPrefix, 'entity');
}

/**
 * Converts a platform/tenant slug into a safe, dynamic PostgreSQL database name.
 * Truncates the base identifier to prevent exceeding PostgreSQL's maximum identifier length (63 bytes).
 * * @param slug - The raw tenant human-readable slug.
 * @returns Formatted database name (e.g., "myproject_tenant_slug").
 */
export function platformSlugToDbName(slug: string): string {
    const prefix = getSanitizedPrefix();
    // Truncate slug identifier to 50 characters to leave room for the prefix and underscore
    const base = toSqlIdentifier(slug, 'entity').slice(0, 50);
    return `${prefix}_${base}`;
}

/**
 * Converts a platform/tenant slug into a safe, dynamic PostgreSQL database owner role name.
 * Formats the string with the system prefix and an "_owner" suffix.
 * * @param slug - The raw tenant human-readable slug.
 * @returns Formatted role name (e.g., "myproject_tenant_slug_owner").
 */
export function platformSlugToDbUser(slug: string): string {
    const prefix = getSanitizedPrefix();
    // Truncate slug identifier to 40 characters to accommodate prefix and "_owner" suffix
    const base = toSqlIdentifier(slug, 'entity').slice(0, 40);
    return `${prefix}_${base}_owner`;
}

/**
 * Generates a cryptographically secure random hexadecimal password string.
 * Uses Node.js native `crypto.randomBytes` to produce 64 characters of random entropy (32 bytes).
 * * @returns Cryptographically secure hex string.
 */
export function generateSecurePassword(): string {
    return crypto.randomBytes(32).toString('hex');
}