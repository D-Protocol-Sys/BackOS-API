import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';
import { ALLOWED_FILE_TYPES, ABSOLUTE_MAX_UPLOAD_SIZE_MB } from './file-type.constant';

// Resolve destination upload directory from environment variables or fallback to a relative local path.
const uploadDir = process.env.UPLOAD_DIR ?? './uploads';

// Ensure the target upload directory exists synchronously upon module initialization.
fs.mkdirSync(uploadDir, { recursive: true });

/**
 * Multer configuration object for handling HTTP multipart file uploads in NestJS controllers.
 * Enforces secure disk storage, file extension normalization, MIME-type filtering, and global size limits.
 */
export const multerOptions = {
    /**
     * Storage Engine Configuration:
     * Writes incoming files directly to the target disk directory.
     */
    storage: diskStorage({
        destination: uploadDir,
        filename: (_req, file, callback) => {
            // Retrieve file specification metadata derived from the incoming MIME type.
            const spec = ALLOWED_FILE_TYPES[file.mimetype];
            const extension = spec?.extension ?? 'bin';

            /*
             * Security Best Practice (Path Traversal & Collision Prevention):
             * Generate a cryptographically random UUID string for the filename instead of 
             * preserving the client-provided `file.originalname`.
             * This completely neutralizes directory traversal attacks (e.g., "../../sh.php")
             * and avoids filename collisions on the storage disk.
             */
            callback(null, `${crypto.randomUUID()}.${extension}`);
        },
    }),

    /**
     * Middleware File Filter:
     * Intercepts and validates the incoming file's MIME type before processing/saving.
     * Rejecting disallowed files early saves network bandwidth and disk I/O.
     */
    fileFilter: (_req: unknown, file: Express.Multer.File, callback: (error: Error | null, accept: boolean) => void) => {
        if (!ALLOWED_FILE_TYPES[file.mimetype]) {
            return callback(
                new BadRequestException(`Unsupported or disallowed file MIME type: ${file.mimetype}`), 
                false,
            );
        }
        callback(null, true);
    },

    /**
     * Hard Request Limits:
     * Enforces the absolute maximum allowed byte threshold at the stream level.
     */
    limits: {
        fileSize: ABSOLUTE_MAX_UPLOAD_SIZE_MB * 1024 * 1024, // Convert Megabytes to Bytes
    },
};

/**
 * Helper utility to return the fully resolved, absolute path of the uploads directory.
 * Useful when serving static files or passing absolute file paths to downstream workers.
 * * @returns Fully qualified absolute file path on the host filesystem.
 */
export function resolveUploadDir(): string {
    return path.resolve(uploadDir);
}