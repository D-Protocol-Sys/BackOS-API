import * as crypto from 'crypto';
import { toSqlIdentifier } from './sql-identifier.util';

export function platformSlugToDbName(slug: string): string {
    const base = toSqlIdentifier(slug, 'entity').slice(0, 55);
    return `bpg_${base}`;
}

export function platformSlugToDbUser(slug: string): string {
    const base = toSqlIdentifier(slug, 'entity').slice(0, 50);
    return `bpg_${base}_owner`;
}

export function generateSecurePassword(): string {
    return crypto.randomBytes(32).toString('hex');
}