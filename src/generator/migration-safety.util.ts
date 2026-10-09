/**
 * DATA-SAFETY (GEN-001): detects SQL statements in a Prisma-generated migration that delete or
 * rewrite existing data. Archiving or deleting an entity/field removes it from `schema.prisma`,
 * and `prisma migrate diff` then emits `DROP COLUMN` / `DROP TABLE`, which `migrate deploy` would
 * apply immediately to the live database of the platform.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
    /\bDROP\s+TABLE\b/i,
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+TYPE\b/i,
    /\bDROP\s+SCHEMA\b/i,
    /\bTRUNCATE\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bALTER\s+COLUMN\s+("[^"]+"|\S+)\s+(SET\s+DATA\s+)?TYPE\b/i,
    /\bALTER\s+COLUMN\s+("[^"]+"|\S+)\s+SET\s+NOT\s+NULL\b/i,
    /\bRENAME\s+(COLUMN|TO)\b/i,
];

/** Returns the destructive statements (trimmed, one line each) found in `sql`. */
export function findDestructiveStatements(sql: string): string[] {
    const withoutComments = sql
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n');

    return withoutComments
        .split(';')
        .map((statement) => statement.replace(/\s+/g, ' ').trim())
        .filter((statement) => statement.length > 0)
        .filter((statement) => DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)));
}
