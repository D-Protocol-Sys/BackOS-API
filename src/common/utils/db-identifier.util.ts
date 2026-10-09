import * as crypto from 'crypto';
import { toSqlIdentifier } from './sql-identifier.util';

/**
 * PostgreSQL identifiers are limited to 63 bytes. The prefix (from SERVER_NAME) is capped so the
 * slug part and the uniqueness suffix always fit.
 */
const MAX_PREFIX_LENGTH = 12;

/**
 * Sanitized, length-capped prefix derived from SERVER_NAME (lets several BackOS instances share a
 * PostgreSQL cluster without clashing).
 */
function getSanitizedPrefix(): string {
    const rawPrefix = process.env.SERVER_NAME || 'app';
    return toSqlIdentifier(rawPrefix, 'entity').slice(0, MAX_PREFIX_LENGTH).replace(/_+$/, '') || 'app';
}

/**
 * SECURITY / RELIABILITY FIX (DB-003): names used to be `prefix_` + a truncated slug, so two
 * distinct slugs could map to the same database/role (truncation at 40/50 characters, or the
 * reserved-word suffix turning `user` into `user_entity`, identical to `user-entity`), making the
 * second platform impossible to provision. A 12-hex-character hash of the immutable platform id is
 * now appended: the readable slug part is kept for operators, uniqueness comes from the id.
 *
 * Only NEW provisionings use this scheme - existing platforms keep the names stored in
 * `PlatformDatabase`, which is always the source of truth once a database exists.
 */
function platformHash(platformId: string): string {
    return crypto.createHash('sha256').update(platformId).digest('hex').slice(0, 12);
}

export function platformSlugToDbName(slug: string, platformId: string): string {
    const base = toSqlIdentifier(slug, 'entity').slice(0, 36).replace(/_+$/, '');
    return `${getSanitizedPrefix()}_${base}_${platformHash(platformId)}`;
}

export function platformSlugToDbUser(slug: string, platformId: string): string {
    const base = toSqlIdentifier(slug, 'entity').slice(0, 30).replace(/_+$/, '');
    return `${getSanitizedPrefix()}_${base}_${platformHash(platformId)}_owner`;
}

/** Name of the dedicated, unprivileged role owning the shared Prisma shadow database. */
export function shadowDatabaseRoleName(): string {
    return `${getSanitizedPrefix()}_migration_shadow`;
}

/**
 * Generates a cryptographically secure random password (64 hex characters, 256 bits).
 */
export function generateSecurePassword(): string {
    return crypto.randomBytes(32).toString('hex');
}
