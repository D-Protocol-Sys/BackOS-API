import { toSqlIdentifier } from './sql-identifier.util';

/**
 * Utility function to sanitize and format a relation field name into a valid SQL identifier.
 * * Ensures the input string complies with SQL identifier naming conventions (e.g., removing invalid
 * characters, escaping reserved SQL keywords, handling case sensitivity, or enforcing length limits).
 * * @param name - The raw field or relation name to sanitize (e.g., "user-order" or "select").
 * @returns A safe, sanitized SQL-compliant field identifier string (e.g., "user_order").
 * * @example
 * sanitizeRelationFieldName("user profile") // Returns "user_profile"
 */
export function sanitizeRelationFieldName(name: string): string {
    // Delegates the sanitization logic to 'toSqlIdentifier', specifying 'field' context
    return toSqlIdentifier(name, 'field');
}
