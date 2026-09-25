import { FieldType } from '@prismamodels/client';

/**
 * Maps every business `FieldType` to the Prisma scalar type used in the generated schema.
 *
 * NOTE: `VIDEO` and `MEDIA` are the two types added for file-array support. Like `IMAGE` and
 * `FILE`, they are stored as plain strings - the public URL returned by the generated
 * backend's `POST /uploads` endpoint (e.g. `/uploads/<uuid>.mp4`) - never as binary data.
 * A field flagged `isArray` is emitted as `<PrismaType>[]` (see `SchemaBuilderService`).
 */
export const FIELD_TYPE_TO_PRISMA: Record<FieldType, string> = {
    STRING: 'String',
    TEXT: 'String',
    NUMBER: 'Float',
    BOOLEAN: 'Boolean',
    DATE: 'DateTime',
    IMAGE: 'String',
    FILE: 'String',
    VIDEO: 'String',
    MEDIA: 'String',
    URL: 'String',
    JSON: 'Json',
};

/**
 * Field types whose values are references to files uploaded through the generated backend's
 * `UploadsController`. Used by the API manifest so a frontend knows which fields need an
 * upload widget rather than a plain text input.
 *
 *  - IMAGE : a single image (jpeg/png/gif/webp)
 *  - VIDEO : a single video (mp4/webm/mov)
 *  - MEDIA : image OR video - the natural type for a mixed "illustration" gallery
 *  - FILE  : any other allowed document (pdf)
 */
export const UPLOAD_FIELD_TYPES: ReadonlySet<string> = new Set(['IMAGE', 'VIDEO', 'MEDIA', 'FILE']);
