import { toCamelCase } from './case.util';
import { FIELD_TYPE_VALIDATORS, tsTypeFor } from './field-type-validator-mapper.util';

/**
 * Minimal shape of a business field, as needed to emit its DTO property.
 * Shared by `CrudGeneratorService` (entity CRUD DTOs) and the "Auth & User" generator (the
 * external-user PROFILE DTO), so both produce identical validation rules for the same field type.
 */
export interface DtoFieldInput {
    column: string;
    type: string;
    required: boolean;
    /** True when the field holds a LIST of values of `type` (e.g. tags: string[]). */
    isArray?: boolean;
    /**
     * Required, and only meaningful, when `type === 'ENUM'`: the exact allowed values, in order
     * (from the field's `EnumDefinition.values`). Drives both the `@IsIn([...])` validator and the
     * TypeScript string-literal union type of the generated property.
     */
    enumValues?: string[];
}

/**
 * Builds the TypeScript property definitions + `class-validator` decorators for a list of fields.
 *
 * SCALAR field  -> `@IsString() @IsNotEmpty() title!: string;`
 * ARRAY field   -> `@IsArray() @IsString({ each: true }) tags?: string[];`
 * ENUM field    -> `@IsIn(['DRAFT', 'ACTIVE']) status!: 'DRAFT' | 'ACTIVE';`
 *
 * Array semantics: a REQUIRED array must contain at least one element (`@ArrayNotEmpty()`, on
 * create AND on update); an OPTIONAL array may be omitted, in which case the database falls back
 * to `[]` (see `@default([])` in `SchemaBuilderService`).
 *
 * @param forceOptional - True for update DTOs (PATCH), where every property is optional.
 */
export function buildDtoFieldsSource(fields: DtoFieldInput[], forceOptional: boolean): string {
    return fields
        .map((field) => {
            const fieldName = toCamelCase(field.column);
            const isArray = Boolean(field.isArray);
            const isOptional = forceOptional || !field.required;
            const isEnum = field.type === 'ENUM';

            const decorators: string[] = [];
            if (isEnum) {
                // `@IsIn()` is the one validator whose argument (the allowed values) is unique to
                // THIS field rather than shared by every field of its type, so it is built here
                // directly instead of coming from `FIELD_TYPE_VALIDATORS`.
                const values = field.enumValues ?? [];
                const literal = `[${values.map((v) => `'${v}'`).join(', ')}]`;
                if (isArray) {
                    decorators.push('@IsArray()', `@IsIn(${literal}, { each: true })`);
                    if (isOptional) decorators.push('@IsOptional()');
                    if (field.required) decorators.push('@ArrayNotEmpty()');
                } else {
                    decorators.push(`@IsIn(${literal})`);
                    if (isOptional) decorators.push('@IsOptional()');
                }
            } else {
                const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
                if (isArray) {
                    decorators.push('@IsArray()', ...spec.eachDecorators);
                    if (isOptional) decorators.push('@IsOptional()');
                    // Also kept on PATCH (where the property may be omitted, but not emptied) so a
                    // required array can never be cleared through an update.
                    if (field.required) decorators.push('@ArrayNotEmpty()');
                } else {
                    decorators.push(...spec.decorators);
                    if (isOptional) decorators.push('@IsOptional()');
                    if (!isOptional && spec.tsType === 'string') decorators.push('@IsNotEmpty()');
                }
            }

            const decoratorLines = decorators.map((d) => `  ${d}`).join('\n');
            const questionMark = isOptional ? '?' : '';
            const definiteAssignment = isOptional ? '' : '!';
            // `tsTypeFor()` already parenthesizes non-enum array element types where needed; for an
            // ENUM array the union must be parenthesized too, or `'A' | 'B'[]` parses as
            // `'A' | ('B'[])` - a completely different (and wrong) type - instead of `('A' | 'B')[]`.
            const tsType = isEnum ? enumUnionType(field.enumValues ?? [], isArray) : tsTypeFor(field.type, isArray);

            return `${decoratorLines}\n  ${fieldName}${questionMark}${definiteAssignment}: ${tsType};`;
        })
        .join('\n\n');
}

/**
 * Names of every `class-validator` decorator that `buildDtoFieldsSource()` will emit for these
 * fields (always includes `IsOptional`, which the schedulable/relation blocks also rely on).
 */
export function collectFieldValidatorImports(fields: DtoFieldInput[]): Set<string> {
    const imports = new Set<string>(['IsOptional']);

    for (const field of fields) {
        if (field.type === 'ENUM') {
            imports.add('IsIn');
            if (field.isArray) {
                imports.add('IsArray');
                if (field.required) imports.add('ArrayNotEmpty');
            }
            continue;
        }

        const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
        const decorators = field.isArray ? ['@IsArray()', '@ArrayNotEmpty()', ...spec.eachDecorators] : [...spec.decorators];

        for (const decorator of decorators) {
            const match = decorator.match(/@(\w+)/);
            if (match) imports.add(match[1]);
        }
        // Required scalar strings receive @IsNotEmpty().
        if (!field.isArray && field.required && spec.tsType === 'string') imports.add('IsNotEmpty');
    }

    return imports;
}

/**
 * `'DRAFT' | 'ACTIVE'`, or `('DRAFT' | 'ACTIVE')[]` for an array field - the parentheses matter:
 * without them, `'A' | 'B'[]` parses as `'A' | ('B'[])`, not `('A' | 'B')[]`.
 * `string` is a harmless fallback for an (invalid, but never actually reachable) empty value list.
 */
function enumUnionType(values: string[], isArray: boolean): string {
    const union = values.length > 0 ? values.map((v) => `'${v}'`).join(' | ') : 'string';
    return isArray ? `(${union})[]` : union;
}
