import { memoryStorage } from 'multer';
import { BadRequestException } from '@nestjs/common';

/**
 * Multer config for `POST /users/me/avatar`, separate from the generic `files/multer.config.ts`:
 * an avatar is a small, already-cropped image (see `AvatarCropModal` on the frontend, which
 * exports a square PNG client-side), never a large document, so it gets its own tight allowlist
 * and size cap rather than the general-purpose one meant for contracts/deliverables.
 *
 * Uses `memoryStorage` (not `diskStorage`): `UsersService.saveAvatar()` needs the raw bytes in
 * hand to run the magic-byte signature check and pick the final on-disk filename itself
 * (`avatars/<userId>.<ext>`, overwriting any previous avatar) - there is no intermediate
 * multer-chosen file to clean up either way.
 */
const ALLOWED_AVATAR_TYPES: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
};

export const AVATAR_MAX_BYTES = 3 * 1024 * 1024;

export function avatarExtensionFor(mimetype: string): string | undefined {
    return ALLOWED_AVATAR_TYPES[mimetype];
}

export const avatarUploadOptions = {
    storage: memoryStorage(),
    fileFilter: (
        _req: unknown,
        file: Express.Multer.File,
        callback: (error: Error | null, accept: boolean) => void,
    ) => {
        if (!ALLOWED_AVATAR_TYPES[file.mimetype]) {
            return callback(
                new BadRequestException(`Unsupported avatar type: ${file.mimetype}. Use PNG, JPEG or WEBP.`),
                false,
            );
        }
        callback(null, true);
    },
    limits: { fileSize: AVATAR_MAX_BYTES, files: 1 },
};
