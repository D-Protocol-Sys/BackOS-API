const RESERVED_SQL_KEYWORDS = new Set([
    'select',
    'insert',
    'update',
    'delete',
    'from',
    'where',
    'table',
    'column',
    'user',
    'group',
    'order',
    'by',
    'having',
    'join',
    'left',
    'right',
    'inner',
    'outer',
    'on',
    'as',
    'and',
    'or',
    'not',
    'null',
    'true',
    'false',
    'primary',
    'key',
    'foreign',
    'references',
    'unique',
    'index',
    'create',
    'drop',
    'alter',
    'default',
    'constraint',
    'check',
    'cascade',
    'grant',
    'revoke',
    'transaction',
    'commit',
    'rollback',
    'union',
    'all',
    'distinct',
    'limit',
    'offset',
    'into',
    'values',
    'set',
    'exists',
    'case',
    'when',
    'then',
    'else',
    'end',
    'like',
    'in',
    'is',
    'between',
    'trigger',
    'function',
    'procedure',
    'view',
    'schema',
    'database',
    'to',
    'with',
    'returning',
]);

export function toSqlIdentifier(input: string, fallbackPrefix: 'entity' | 'field'): string {
    let result = input
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .replace(/_{2,}/g, '_')
        .slice(0, 63);

    if (!result || /^[0-9]/.test(result)) {
        result = `${fallbackPrefix}_${result}`.slice(0, 63);
    }

    if (RESERVED_SQL_KEYWORDS.has(result)) {
        result = `${result}_${fallbackPrefix}`;
    }

    return result || fallbackPrefix;
}
/**
 * GEN-006: table names that would collide with folders/files or Prisma models written by the
 * generator itself (core modules and optional services). An entity whose name maps to one of
 * them gets a suffix, instead of silently overwriting generated security code (e.g. an entity
 * called "users" used to overwrite the Auth & User service's `src/users/*`).
 */
export const RESERVED_TABLE_NAMES = new Set([
    'app',
    'main',
    'auth',
    'common',
    'mail',
    'tasks',
    'users',
    'health',
    'uploads',
    'prisma',
    'generated',
    'app_user',
    'app_users',
    'app_user_profile',
    'app_user_profiles',
    'app_internal_account',
    'app_internal_accounts',
    'app_signup_request',
    'app_signup_requests',
    'app_otp_code',
    'app_otp_codes',
    'app_refresh_token',
    'app_refresh_tokens',
    'scheduled_task',
    'scheduled_tasks',
]);

/** GEN-006: Prisma field names always generated on every model. */
export const RESERVED_FIELD_NAMES = new Set(['id', 'createdAt', 'updatedAt', 'publishAt', 'unpublishAt']);
