import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { BadRequestException } from '@nestjs/common';
import { ALLOWED_FILE_TYPES, ABSOLUTE_MAX_UPLOAD_SIZE_MB } from './file-type.constant';

/**
 * Absolute path of the uploads directory.
 *
 * CONFIG FIX (FILE-004): `UPLOAD_DIR` used to be read once, when this module was first imported -
 * before `ConfigModule` had loaded the `.env.<NODE_ENV>` file - so a value set there was ignored.
 * It is now resolved at every call. In Docker it must point to a mounted volume (FILE-001).
 */
export function resolveUploadDir(): string {
    return path.resolve(process.env.UPLOAD_DIR ?? './uploads');
}

/**
 * Configuration options for Multer (Express middleware for handling multipart/form-data).
 * Files are written under a random server-generated name; the client-provided name is only
 * kept as metadata.
 */
export const multerOptions = {
    storage: diskStorage({
        destination: (_req, _file, callback) => {
            const dir = resolveUploadDir();
            fs.mkdir(dir, { recursive: true }, (error) => callback(error ?? null, dir));
        },
        filename: (_req, file, callback) => {
            const spec = ALLOWED_FILE_TYPES[file.mimetype];
            const extension = spec?.extension ?? 'bin';
            callback(null, `${crypto.randomUUID()}.${extension}`);
        },
    }),

    fileFilter: (_req: unknown, file: Express.Multer.File, callback: (error: Error | null, accept: boolean) => void) => {
        if (!ALLOWED_FILE_TYPES[file.mimetype]) {
            return callback(
                new BadRequestException(`Unsupported or disallowed file MIME type: ${file.mimetype}`),
                false,
            );
        }
        callback(null, true);
    },

    limits: {
        fileSize: ABSOLUTE_MAX_UPLOAD_SIZE_MB * 1024 * 1024,
        files: 1,
    },
};
