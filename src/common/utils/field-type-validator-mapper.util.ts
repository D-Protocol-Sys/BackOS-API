import { FieldType } from '@prismamodels/client';

interface ValidatorSpec {
    decorators: string[];
    tsType: string;
    isDateField: boolean;
}

export const FIELD_TYPE_VALIDATORS: Record<FieldType, ValidatorSpec> = {
    STRING: { decorators: ['@IsString()'], tsType: 'string', isDateField: false },
    TEXT: { decorators: ['@IsString()'], tsType: 'string', isDateField: false },
    IMAGE: { decorators: ['@IsString()'], tsType: 'string', isDateField: false },
    FILE: { decorators: ['@IsString()'], tsType: 'string', isDateField: false },
    URL: { decorators: ['@IsString()', '@IsUrl({ require_tld: false })'], tsType: 'string', isDateField: false },
    NUMBER: { decorators: ['@IsNumber()'], tsType: 'number', isDateField: false },
    BOOLEAN: { decorators: ['@IsBoolean()'], tsType: 'boolean', isDateField: false },
    DATE: { decorators: ['@IsDateString()'], tsType: 'string', isDateField: true },
    JSON: { decorators: ['@IsObject()'], tsType: 'Record<string, unknown>', isDateField: false },
};