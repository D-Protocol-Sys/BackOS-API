import { toSqlIdentifier } from './sql-identifier.util';

export function sanitizeRelationFieldName(name: string): string {
    return toSqlIdentifier(name, 'field');
}