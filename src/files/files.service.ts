import {
    Injectable,
    Logger,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
    PayloadTooLargeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PlanningService } from '../planning/planning.service';
import { ALLOWED_FILE_TYPES } from './file-type.constant';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { resolveUploadDir } from './multer.config';
import { matchesFileSignature, SIGNATURE_SAMPLE_BYTES } from './file-signature.util';

/**
 * Type representing the authenticated user performing the file action.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * A file's parent, expressed as at most one set FK - see `assertSingleParent()`. All three are
 * optional and independent because a `FileAsset` can attach to any one of them (or none at
 * all, for a bare unattached upload), but never more than one at a time.
 */
type FileParent = { planningEntryId?: string; projectId?: string; contractId?: string };

/**
 * Service managing uploaded file metadata, authorization controls,
 * fine-grained size validation, and physical disk file lifecycle operations.
 */
@Injectable()
export class FilesService {
    private readonly logger = new Logger(FilesService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly planningService: PlanningService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Validates and persists an uploaded file's metadata into the database.
     * Enforces strict MIME type specifications and category-specific size restrictions.
     * * @param actor - The user initiating the file upload.
     * @param file - Express Multer file object created during upload.
     * @param parent - At most one of `planningEntryId`/`projectId`/`contractId` - see
     *   `assertSingleParent()`. Leave all unset for a bare unattached upload.
     * @returns The saved FileAsset record in database.
     */
    async saveUploadedFile(actor: Actor, file: Express.Multer.File, parent: FileParent = {}) {
        if (!file) {
            throw new BadRequestException('No file was provided (expected multipart field "file").');
        }

        // FILE-002: the file is already on disk when this runs (Multer). ANY rejection below -
        // including a failed authorization on the parent, which used to leave the file behind
        // forever - now deletes it.
        try {
            return await this.persistUploadedFile(actor, file, parent);
        } catch (error) {
            await this.safeDeleteFromDisk(file.filename);
            throw error;
        }
    }

    private async persistUploadedFile(actor: Actor, file: Express.Multer.File, parent: FileParent) {
        const { planningEntryId, projectId, contractId } = parent;

        this.assertSingleParent(parent);

        const spec = ALLOWED_FILE_TYPES[file.mimetype];
        if (!spec) {
            throw new BadRequestException(`File MIME type not allowed: ${file.mimetype}`);
        }

        const maxBytes = spec.maxSizeMb * 1024 * 1024;
        if (file.size > maxBytes) {
            throw new BadRequestException(
                `File size exceeds the maximum limit for category ${spec.category} (Max ${spec.maxSizeMb} MB).`,
            );
        }

        const signatureOk = await this.verifyFileSignature(file);
        if (!signatureOk) {
            throw new BadRequestException('File content does not match its declared type. Upload rejected.');
        }

        // FILE-002: per-user storage quota (disk exhaustion by any authenticated account).
        const quotaBytes = this.configService.get<number>('USER_UPLOAD_QUOTA_MB', 1024) * 1024 * 1024;
        const used = await this.prisma.fileAsset.aggregate({
            where: { uploaderId: actor.userId },
            _sum: { sizeBytes: true },
        });
        if ((used._sum.sizeBytes ?? 0) + file.size > quotaBytes) {
            throw new PayloadTooLargeException('Storage quota exceeded. Delete some files before uploading new ones.');
        }

        if (planningEntryId) {
            await this.planningService.assertCanEditEntry(actor, planningEntryId);
        }
        if (projectId) {
            await this.assertCanEditProject(actor, projectId);
        }
        if (contractId) {
            await this.assertCanEditContract(actor, contractId);
        }

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
                projectId,
                contractId,
            },
        });
    }

    private assertSingleParent(parent: FileParent): void {
        const setCount = [parent.planningEntryId, parent.projectId, parent.contractId].filter(
            (value) => value !== undefined && value !== null && value !== '',
        ).length;

        if (setCount > 1) {
            throw new BadRequestException(
                'A file can be attached to at most one of planningEntryId, projectId or contractId - not several at once.',
            );
        }
    }

    /**
     * Asserts the actor may attach/manage files on the given project: the project's manager,
     * or a global `PROJECT_UPDATE` permission holder - mirrors
     * `ProjectsService.assertManagerOrGlobalPermission()` exactly. Checked directly against
     * Prisma here (rather than injecting `ProjectsService`) to avoid a module import cycle:
     * `ProjectsModule` needs `FilesModule` (to purge a project's files when the project itself
     * is deleted), so `FilesModule` cannot also depend on `ProjectsModule`.
     */
    private async assertCanEditProject(actor: Actor, projectId: string): Promise<void> {
        const project = await this.prisma.project.findUnique({ where: { id: projectId } });
        if (!project) throw new BadRequestException('Target project not found.');
        if (project.managerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PROJECT_UPDATE)) return;
        throw new ForbiddenException('You do not have permission to attach files to this project.');
    }

    /**
     * Asserts the actor may attach/manage files on the given contract. Contracts have no
     * per-record ownership concept (see `ClientsService`) - authorization is the global
     * `CONTRACT_UPDATE` permission, same as every other contract-mutating action.
     */
    private async assertCanEditContract(actor: Actor, contractId: string): Promise<void> {
        if (actor.permissions.includes(PERMISSIONS.CONTRACT_UPDATE)) return;
        const contract = await this.prisma.clientContract.findUnique({ where: { id: contractId } });
        if (!contract) throw new NotFoundException('Contract not found.');
        throw new ForbiddenException('You do not have permission to attach files to this contract.');
    }

    /**
     * Reads back the leading bytes of a just-written upload from disk and checks them against
     * the magic-byte signature expected for the MIME type the client declared. Kept as its own
     * method so the read is isolated and easy to unit-test / reason about independently of the
     * rest of `saveUploadedFile()`'s flow.
     *
     * @param file - Express Multer file object (already written to disk by the time this runs).
     * @returns `true` if the sampled bytes match the declared type (or the type has no known
     *   signature - see `matchesFileSignature`), `false` otherwise.
     */
    private async verifyFileSignature(file: Express.Multer.File): Promise<boolean> {
        const diskPath = path.join(resolveUploadDir(), file.filename);
        let handle: fs.FileHandle | undefined;
        try {
            handle = await fs.open(diskPath, 'r');
            const { buffer, bytesRead } = await handle.read(
                Buffer.alloc(SIGNATURE_SAMPLE_BYTES),
                0,
                SIGNATURE_SAMPLE_BYTES,
                0,
            );
            return matchesFileSignature(file.mimetype, buffer.subarray(0, bytesRead));
        } catch {
            // If the file can't even be read back (disk error, race condition), fail closed:
            // treat it as a signature mismatch rather than silently accepting an unverified file.
            return false;
        } finally {
            await handle?.close();
        }
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

        // Inherited Access Rule: same idea, for a file attached to a project - readable by
        // anyone who can read the project (manager, or global PROJECT_READ holder).
        if (file.projectId) {
            if (actor.permissions.includes(PERMISSIONS.PROJECT_READ)) return file;
            const project = await this.prisma.project.findUnique({ where: { id: file.projectId } });
            if (project?.managerId === actor.userId) return file;
            throw new ForbiddenException('You do not have access to this file.');
        }

        // Inherited Access Rule: same idea, for a file attached to a contract - contracts have
        // no per-record ownership, so this is the global CONTRACT_READ permission alone.
        if (file.contractId) {
            if (actor.permissions.includes(PERMISSIONS.CONTRACT_READ)) return file;
            throw new ForbiddenException('You do not have access to this file.');
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
            } else if (file.projectId) {
                await this.assertCanEditProject(actor, file.projectId);
            } else if (file.contractId) {
                await this.assertCanEditContract(actor, file.contractId);
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
     * System-level purge: deletes every `FileAsset` attached to the given project or contract
     * (disk file + database row for each), with no `actor`/permission check - this is called
     * exclusively from `ProjectsService.delete()` and `ClientsService`'s purge lifecycle
     * (`purgeContractInternal()`), i.e. only after the caller has already authorized the
     * destructive action on the *parent* resource. Exactly one of `projectId`/`contractId`
     * must be given.
     *
     * Each file's disk removal is individually best-effort (mirrors `PlatformsService.
     * purgePlatform()`'s own file cleanup) - one missing/locked file must not abort the rest of
     * the batch or the parent purge that triggered it.
     *
     * @returns The count of files permanently deleted.
     */
    async purgeFilesForParent(parent: { projectId?: string; contractId?: string }): Promise<number> {
        const { projectId, contractId } = parent;
        if ((projectId && contractId) || (!projectId && !contractId)) {
            throw new BadRequestException('purgeFilesForParent requires exactly one of projectId or contractId.');
        }

        const files = await this.prisma.fileAsset.findMany({
            where: projectId ? { projectId } : { contractId },
            select: { id: true, storedName: true },
        });

        let purgedCount = 0;
        for (const file of files) {
            try {
                await this.safeDeleteFromDisk(file.storedName);
                await this.prisma.fileAsset.delete({ where: { id: file.id } });
                purgedCount++;
            } catch (error) {
                this.logger.warn(
                    `Could not fully purge file ${file.id} for ${projectId ? `project ${projectId}` : `contract ${contractId}`}.`,
                    error instanceof Error ? error.stack : String(error),
                );
            }
        }

        return purgedCount;
    }

    /**
     * Resolves the full physical path of a stored file on disk.
     * * @param storedName - The random filename assigned on storage disk.
     * @returns Fully qualified absolute system filepath.
     */
    resolveDiskPath(storedName: string): string {
        return path.join(resolveUploadDir(), path.basename(storedName));
    }

    /**
     * Safely attempts to remove a file from disk storage without throwing uncaught runtime exceptions.
     * Implements a best-effort pattern for filesystem cleanups.
     * * @param storedName - Unique filename saved on disk.
     */
    private async safeDeleteFromDisk(storedName: string | undefined) {
        if (!storedName) return;
        try {
            await fs.unlink(path.join(resolveUploadDir(), path.basename(storedName)));
        } catch {
            // File might already be missing or removed; ignore error gracefully (best-effort strategy).
        }
    }
}
