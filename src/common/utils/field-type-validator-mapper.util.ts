import { FieldType } from '@prismamodels/client';

export interface ValidatorSpec {
    /** class-validator decorators applied to a SCALAR field of this type. */
    decorators: string[];
    /**
     * The same checks, applied element by element (`{ each: true }`) when the field is an
     * ARRAY (`Field.isArray`). Kept explicit rather than derived from `decorators` by string
     * manipulation, because the position of the options argument differs per decorator
     * (`@IsString(opts)` vs `@IsNumber(numberOpts, opts)` vs `@IsUrl(urlOpts, opts)`).
     */
    eachDecorators: string[];
    tsType: string;
    isDateField: boolean;
}

export const FIELD_TYPE_VALIDATORS: Record<FieldType, ValidatorSpec> = {
    STRING: { decorators: ['@IsString()'], eachDecorators: ['@IsString({ each: true })'], tsType: 'string', isDateField: false },
    TEXT: { decorators: ['@IsString()'], eachDecorators: ['@IsString({ each: true })'], tsType: 'string', isDateField: false },
    IMAGE: { decorators: ['@IsString()'], eachDecorators: ['@IsString({ each: true })'], tsType: 'string', isDateField: false },
    FILE: { decorators: ['@IsString()'], eachDecorators: ['@IsString({ each: true })'], tsType: 'string', isDateField: false },
    VIDEO: { decorators: ['@IsString()'], eachDecorators: ['@IsString({ each: true })'], tsType: 'string', isDateField: false },
    MEDIA: { decorators: ['@IsString()'], eachDecorators: ['@IsString({ each: true })'], tsType: 'string', isDateField: false },
    URL: {
        decorators: ['@IsString()', '@IsUrl({ require_tld: false })'],
        eachDecorators: ['@IsString({ each: true })', '@IsUrl({ require_tld: false }, { each: true })'],
        tsType: 'string',
        isDateField: false,
    },
    NUMBER: { decorators: ['@IsNumber()'], eachDecorators: ['@IsNumber({}, { each: true })'], tsType: 'number', isDateField: false },
    BOOLEAN: { decorators: ['@IsBoolean()'], eachDecorators: ['@IsBoolean({ each: true })'], tsType: 'boolean', isDateField: false },
    DATE: { decorators: ['@IsDateString()'], eachDecorators: ['@IsDateString({}, { each: true })'], tsType: 'string', isDateField: true },
    JSON: { decorators: ['@IsObject()'], eachDecorators: ['@IsObject({ each: true })'], tsType: 'Record<string, unknown>', isDateField: false },
};

/**
 * TypeScript type of a field's value in a generated DTO / API manifest: `string` for a scalar
 * STRING field, `string[]` for an array of them.
 */
export function tsTypeFor(type: string, isArray: boolean): string {
    const base = FIELD_TYPE_VALIDATORS[type as keyof typeof FIELD_TYPE_VALIDATORS].tsType;
    return isArray ? `${base}[]` : base;
}
