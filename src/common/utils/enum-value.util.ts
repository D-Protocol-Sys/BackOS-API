import { BadRequestException } from '@nestjs/common';

/**
 * Shape an ENUM option must have. Deliberately restrictive (no free-form text, no spaces,
 * no accents) rather than accepting anything and silently mangling it: this exact string becomes
 * BOTH a Prisma enum member name in the generated backend's own schema.prisma AND the literal
 * value the generated API sends/accepts in JSON (see `SchemaBuilderService` - no `@map()`
 * translation layer is used, on purpose, so nothing is lost or renamed between the value the
 * platform owner typed here and what a client of the generated backend actually sees).
 */
export const ENUM_VALUE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
export const MAX_ENUM_VALUES = 50;
export const MAX_ENUM_VALUE_LENGTH = 40;

/**
 * Validates a full set of options for one `EnumDefinition`: each value must match
 * `ENUM_VALUE_PATTERN`, the set must be non-empty, capped, and free of duplicates.
 * @throws BadRequestException describing the first problem found.
 */
export function assertValidEnumValues(values: string[]): void {
    if (values.length === 0) {
        throw new BadRequestException('An enum needs at least one value.');
    }
    if (values.length > MAX_ENUM_VALUES) {
        throw new BadRequestException(`An enum can have at most ${MAX_ENUM_VALUES} values.`);
    }
    const seen = new Set<string>();
    for (const value of values) {
        if (value.length > MAX_ENUM_VALUE_LENGTH) {
            throw new BadRequestException(`"${value}" is too long (max ${MAX_ENUM_VALUE_LENGTH} characters).`);
        }
        if (!ENUM_VALUE_PATTERN.test(value)) {
            throw new BadRequestException(
                `"${value}" is not a valid enum value: use only letters, digits and underscores, starting with a letter (e.g. "IN_PROGRESS").`,
            );
        }
        if (seen.has(value)) {
            throw new BadRequestException(`"${value}" appears more than once.`);
        }
        seen.add(value);
    }
}

/**
 * When a platform is already generated (`LOCKED_STATUSES`), an enum's existing options can never
 * be renamed or removed - only new ones appended - because the Prisma enum member names ARE the
 * stored values: renaming or dropping one would break every row of every already-generated
 * database that used it. Adding new ones at the end is always safe.
 * @throws BadRequestException if `nextValues` is not `previousValues` plus zero or more appended entries.
 */
export function assertEnumValuesOnlyAppended(previousValues: string[], nextValues: string[]): void {
    const stillPresent = previousValues.every((value, index) => nextValues[index] === value);
    if (!stillPresent) {
        throw new BadRequestException(
            'This platform has already been generated: existing enum values cannot be renamed, reordered or removed - only new ones can be added at the end.',
        );
    }
}

/**
 * The Prisma `enum` type name a given `EnumDefinition.name` becomes in the generated
 * schema.prisma. Splits on any run of non-alphanumeric characters (not just underscores, unlike
 * `toPascalCase`) so a human-friendly name such as "Project Status" still produces a valid Prisma
 * identifier ("ProjectStatusEnum") instead of one containing a space.
 */
export function toEnumPrismaName(name: string): string {
    const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
    const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
    return `${pascal || 'Enum'}Enum`;
}
