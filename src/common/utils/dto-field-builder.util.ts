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
}

/**
 * Builds the TypeScript property definitions + `class-validator` decorators for a list of fields.
 *
 * SCALAR field  -> `@IsString() @IsNotEmpty() title!: string;`
 * ARRAY field   -> `@IsArray() @IsString({ each: true }) tags?: string[];`
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
            const spec = FIELD_TYPE_VALIDATORS[field.type as keyof typeof FIELD_TYPE_VALIDATORS];
            const isArray = Boolean(field.isArray);
            const isOptional = forceOptional || !field.required;

            const decorators: string[] = [];
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

            const decoratorLines = decorators.map((d) => `  ${d}`).join('\n');
            const questionMark = isOptional ? '?' : '';
            const definiteAssignment = isOptional ? '' : '!';

            return `${decoratorLines}\n  ${fieldName}${questionMark}${definiteAssignment}: ${tsTypeFor(field.type, isArray)};`;
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
