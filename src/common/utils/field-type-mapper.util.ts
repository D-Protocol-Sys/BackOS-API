import { FieldType } from '@prismamodels/client';

export const FIELD_TYPE_TO_PRISMA: Record<FieldType, string> = {
    STRING: 'String',
    TEXT: 'String',
    NUMBER: 'Float',
    BOOLEAN: 'Boolean',
    DATE: 'DateTime',
    IMAGE: 'String',
    FILE: 'String',
    URL: 'String',
    JSON: 'Json',
};