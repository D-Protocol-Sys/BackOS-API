const RESERVED_SQL_KEYWORDS = new Set([
    'select', 'insert', 'update', 'delete', 'from', 'where', 'table', 'column',
    'user', 'group', 'order', 'by', 'having', 'join', 'left', 'right', 'inner',
    'outer', 'on', 'as', 'and', 'or', 'not', 'null', 'true', 'false', 'primary',
    'key', 'foreign', 'references', 'unique', 'index', 'create', 'drop', 'alter',
    'default', 'constraint', 'check', 'cascade', 'grant', 'revoke', 'transaction',
    'commit', 'rollback', 'union', 'all', 'distinct', 'limit', 'offset', 'into',
    'values', 'set', 'exists', 'case', 'when', 'then', 'else', 'end', 'like',
    'in', 'is', 'between', 'trigger', 'function', 'procedure', 'view', 'schema',
    'database', 'to', 'with', 'returning',
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