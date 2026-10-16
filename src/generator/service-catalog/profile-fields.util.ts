import { BadRequestException } from '@nestjs/common';
import { toSqlIdentifier } from '../../common/utils/sql-identifier.util';
import { toCamelCase } from '../../common/utils/case.util';
import { FIELD_TYPE_TO_PRISMA } from '../../common/utils/field-type-mapper.util';

/**
 * One field of the PROFILE that an external user of a generated backend fills in after creating
 * their account (Auth & User service, when external users are enabled). Defined by whoever
 * manages the platform, stored in the `profileFields` system setting of the `auth-user` service.
 */
export interface ProfileFieldDefinition {
    /** Human-readable name shown in forms ("Date de naissance"). */
    name: string;
    /** SQL-safe snake_case identifier derived from `name` (`date_de_naissance`); the column name. */
    column: string;
    /** One of the platform's `FieldType` values (STRING, IMAGE, MEDIA, DATE, ...). */
    type: string;
    /**
     * A required profile field does NOT block sign-up (an account is created with just first name,
     * last name and e-mail); it only marks the profile as incomplete until it is filled in.
     */
    required: boolean;
    /** True when the field holds a list of values (interests, gallery, ...). */
    isArray: boolean;
}

/** Key under which the definitions live inside the `auth-user` service configuration. */
export const PROFILE_FIELDS_CONFIG_KEY = 'profileFields';

/** Upper bound on profile fields - keeps the generated table and DTO reasonable. */
export const MAX_PROFILE_FIELDS = 30;

/**
 * Property names already used by the account itself (or by Prisma on the profile model), which a
 * profile field must not shadow.
 */
const RESERVED_PROPERTY_NAMES = new Set([
    'id',
    'user',
    'userId',
    'email',
    'firstName',
    'lastName',
    'isActive',
    'profile',
    'createdAt',
    'updatedAt',
]);

/**
 * Lenient reader used by the code generators: returns the well-formed definitions found in a
 * service config and silently ignores anything malformed, so a corrupted setting can never crash
 * a generation halfway through.
 */
export function readProfileFields(config: Record<string, unknown>): ProfileFieldDefinition[] {
    const raw = config[PROFILE_FIELDS_CONFIG_KEY];
    if (!Array.isArray(raw)) return [];

    const result: ProfileFieldDefinition[] = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Record<string, unknown>;
        if (
            typeof candidate.name !== 'string' ||
            typeof candidate.column !== 'string' ||
            typeof candidate.type !== 'string' ||
            !(candidate.type in FIELD_TYPE_TO_PRISMA)
        ) {
            continue;
        }
        result.push({
            name: candidate.name,
            column: candidate.column,
            type: candidate.type,
            required: candidate.required === true,
            isArray: candidate.isArray === true,
        });
    }
    return result;
}

/**
 * Strict builder used when the platform owner SAVES the profile definition: validates the input,
 * derives each column name from the field name, and guarantees the result is safe to turn into a
 * Prisma model (unique, non-reserved property names).
 *
 * @throws BadRequestException on an unknown type, a duplicate/reserved name, or too many fields.
 */
export function buildProfileFieldDefinitions(
    input: { name: string; type: string; required?: boolean; isArray?: boolean }[],
): ProfileFieldDefinition[] {
    if (input.length > MAX_PROFILE_FIELDS) {
        throw new BadRequestException(`A profile can have at most ${MAX_PROFILE_FIELDS} fields.`);
    }

    const usedColumns = new Set<string>();
    const definitions: ProfileFieldDefinition[] = [];

    for (const field of input) {
        if (!(field.type in FIELD_TYPE_TO_PRISMA)) {
            throw new BadRequestException(`Unknown field type "${field.type}" for profile field "${field.name}".`);
        }

        const baseColumn = toSqlIdentifier(field.name, 'field');
        let column = baseColumn;
        let counter = 2;
        while (usedColumns.has(column)) {
            column = `${baseColumn}_${counter}`;
            counter++;
        }
        usedColumns.add(column);

        if (RESERVED_PROPERTY_NAMES.has(toCamelCase(column))) {
            throw new BadRequestException(
                `"${field.name}" is a reserved name (it is already part of every account) - please choose another one.`,
            );
        }

        definitions.push({
            name: field.name.trim(),
            column,
            type: field.type,
            required: field.required ?? false,
            isArray: field.isArray ?? false,
        });
    }

    return definitions;
}
