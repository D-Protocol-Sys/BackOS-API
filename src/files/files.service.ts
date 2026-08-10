import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PlanningService } from '../planning/planning.service';
import { ALLOWED_FILE_TYPES } from './file-type.constant';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { resolveUploadDir } from './multer.config';

/**
 * Type representing the authenticated user performing the file action.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Service managing uploaded file metadata, authorization controls, 
 * fine-grained size validation, and physical disk file lifecycle operations.
 */
@Injectable()
export class FilesService {
    constructor(
        private readonly prisma: PrismaService,
        private readonly planningService: PlanningService,
    ) {}

    /**
     * Validates and persists an uploaded file's metadata into the database.
     * Enforces strict MIME type specifications and category-specific size restrictions.
     * * @param actor - The user initiating the file upload.
     * @param file - Express Multer file object created during upload.
     * @param planningEntryId - Optional ID of an associated planning entry.
     * @returns The saved FileAsset record in database.
     */
    async saveUploadedFile(
        actor: Actor,
        file: Express.Multer.File,
        planningEntryId?: string,
    ) {
        // 1. Verify that the file MIME type is allowed by the system configuration.
        const spec = ALLOWED_FILE_TYPES[file.mimetype];
        if (!spec) {
            // Immediately purge the orphaned file saved on disk by Multer before throwing.
            await this.safeDeleteFromDisk(file.filename);
            throw new BadRequestException(`File MIME type not allowed: ${file.mimetype}`);
        }

        // 2. Enforce precise category-level file size restrictions (more specific than global limit).
        const maxBytes = spec.maxSizeMb * 1024 * 1024;
        if (file.size > maxBytes) {
            // Immediately purge file from disk if it exceeds its specific category threshold.
            await this.safeDeleteFromDisk(file.filename);
            throw new BadRequestException(
                `File size exceeds the maximum limit for category ${spec.category} (Max ${spec.maxSizeMb} MB).`,
            );
        }

        // 3. Verify user permissions on associated resources before establishing attachment links.
        if (planningEntryId) {
            /*
             * Verify that the user has edit permissions for the target planning entry 
             * BEFORE attaching the file, using the exact same authorization logic.
             */
            await this.planningService.assertCanEditEntry(actor, planningEntryId);
        }

        // 4. Save file metadata in database central storage.
        return this.prisma.fileAsset.create({
            data: {
                uploaderId: actor.userId,
                originalName: file.originalname,
                storedName: file.filename,
                mimeType: file.mimetype,
                extension: spec.extension,
                category: spec.category,
                sizeBytes: file.size,
                planningEntryId,
            },
        });
    }

    /**
     * Retrieves file metadata record by unique ID.
     * * @param id - Unique database identifier of the file asset.
     * @throws NotFoundException - If no file matching the ID exists.
     */
    async getById(id: string) {
        const file = await this.prisma.fileAsset.findUnique({ where: { id } });
        if (!file) throw new NotFoundException('File not found.');
        return file;
    }

    /**
     * Asserts whether the requesting actor is authorized to read/download a given file.
     * Access is granted if actor is owner, global manager, or holds access to linked resource.
     * * @param actor - User attempting to access the file.
     * @param fileId - ID of the target file.
     */
    async assertCanAccess(actor: Actor, fileId: string) {
        const file = await this.getById(fileId);

        // Direct Owner Access Rule: The user who uploaded the file can always access it.
        if (file.uploaderId === actor.userId) return file;

        // Manager Privilege Rule: Users with global file management permissions are granted access.
        if (actor.permissions.includes(PERMISSIONS.FILE_MANAGE)) return file;

        // Inherited Access Rule: Access granted if user can view the linked planning entry.
        if (file.planningEntryId) {
            await this.planningService.assertCanViewEntry(actor, file.planningEntryId);
            return file;
        }

        throw new ForbiddenException('You do not have access to this file.');
    }

    /**
     * Deletes file metadata record and removes the corresponding physical file from disk.
     * * @param actor - User requesting file deletion.
     * @param fileId - ID of target file asset.
     */
    async delete(actor: Actor, fileId: string) {
        const file = await this.getById(fileId);
        const isOwner = file.uploaderId === actor.userId;
        const isGlobalManager = actor.permissions.includes(PERMISSIONS.FILE_MANAGE);

        // Evaluate deletion authorization hierarchy
        if (!isOwner && !isGlobalManager) {
            if (file.planningEntryId) {
                // Users with edit privileges on linked resource can also manage/delete its files.
                await this.planningService.assertCanEditEntry(actor, file.planningEntryId);
            } else {
                throw new ForbiddenException('Only the owner of the file can delete it.');
            }
        }

        // Delete underlying storage file first, then purge database entry
        await this.safeDeleteFromDisk(file.storedName);
        await this.prisma.fileAsset.delete({ where: { id: fileId } });
        return { message: 'File deleted successfully.' };
    }

    /**
     * Resolves the full physical path of a stored file on disk.
     * * @param storedName - The random filename assigned on storage disk.
     * @returns Fully qualified absolute system filepath.
     */
    resolveDiskPath(storedName: string): string {
        return path.join(resolveUploadDir(), storedName);
    }

    /**
     * Safely attempts to remove a file from disk storage without throwing uncaught runtime exceptions.
     * Implements a best-effort pattern for filesystem cleanups.
     * * @param storedName - Unique filename saved on disk.
     */
    private async safeDeleteFromDisk(storedName: string) {
        try {
            await fs.unlink(path.join(resolveUploadDir(), storedName));
        } catch {
            // File might already be missing or removed; ignore error gracefully (best-effort strategy).
        }
    }
}