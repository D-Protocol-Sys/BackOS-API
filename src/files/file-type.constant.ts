import { FileCategory } from '@prismamodels/client';

/**
 * Interface defining the specification for allowed file upload types.
 * Maps MIME types to their system categories, file extensions, and individual size limits.
 */
export interface FileTypeSpec {
    /** High-level file categorization for business logic and filtering. */
    category: FileCategory;

    /** Standardized file extension for safe storage naming conventions. */
    extension: string;

    /** Maximum allowed file size in Megabytes for this specific MIME type. */
    maxSizeMb: number;
}

/**
 * Registry of permitted MIME types mapped to their validation constraints.
 * Used during file uploads to enforce type safety, extension mapping, and size restrictions.
 */
export const ALLOWED_FILE_TYPES: Record<string, FileTypeSpec> = {
    // Document Formats
    'application/pdf': { category: 'DOCUMENT', extension: 'pdf', maxSizeMb: 25 },
    'application/msword': { category: 'DOCUMENT', extension: 'doc', maxSizeMb: 25 },
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
        category: 'DOCUMENT',
        extension: 'docx',
        maxSizeMb: 25,
    },
    'text/plain': { category: 'DOCUMENT', extension: 'txt', maxSizeMb: 5 },

    // Spreadsheet Formats
    'text/csv': { category: 'SPREADSHEET', extension: 'csv', maxSizeMb: 15 },
    'application/vnd.ms-excel': { category: 'SPREADSHEET', extension: 'xls', maxSizeMb: 25 },
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
        category: 'SPREADSHEET',
        extension: 'xlsx',
        maxSizeMb: 25,
    },

    // Presentation Formats
    'application/vnd.ms-powerpoint': { category: 'PRESENTATION', extension: 'ppt', maxSizeMb: 40 },
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
        category: 'PRESENTATION',
        extension: 'pptx',
        maxSizeMb: 40,
    },

    // Image Formats
    'image/jpeg': { category: 'IMAGE', extension: 'jpg', maxSizeMb: 10 },
    'image/png': { category: 'IMAGE', extension: 'png', maxSizeMb: 10 },
    'image/gif': { category: 'IMAGE', extension: 'gif', maxSizeMb: 10 },
    'image/webp': { category: 'IMAGE', extension: 'webp', maxSizeMb: 10 },

    // Archive Formats
    'application/zip': { category: 'ARCHIVE', extension: 'zip', maxSizeMb: 100 },
    'application/x-zip-compressed': { category: 'ARCHIVE', extension: 'zip', maxSizeMb: 100 },
};

/**
 * Absolute upper bound for file uploads passed to the file-processing middleware (e.g., Multer).
 * Serves as a raw safety guard rail at the network layer before processing file streams.
 * Specific category size limits are subsequently enforced in the `FilesService`.
 */
export const ABSOLUTE_MAX_UPLOAD_SIZE_MB = 100;
