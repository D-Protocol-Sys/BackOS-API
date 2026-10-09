import {
    Controller, Post, Get, Delete, Param, Query, Body, UploadedFile, UseInterceptors, UseGuards, Res, NotFoundException,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { FilesService } from './files.service';
import { multerOptions } from './multer.config';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import * as fs from 'fs';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { buildContentDisposition } from '../common/utils/content-disposition.util';
import { streamFileToResponse } from '../common/utils/stream-file.util';

/**
 * Type representing the authenticated user extracted from request context.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * NestJS Controller responsible for HTTP endpoints handling file uploads, 
 * metadata retrieval, secure stream downloading, and file deletions.
 */
@ApiTags('files')
@ApiBearerAuth('access-token')
@Controller('files')
export class FilesController {
    constructor(private readonly filesService: FilesService) {}

    /**
     * Endpoint for uploading single multipart file attachments.
     * Intercepted by Multer to validate and store the file on disk before hitting the handler.
     * * @param actor - The authenticated user extracted from token/session.
     * @param file - File object uploaded via multipart form-data ('file' field).
     * @param planningEntryId - Optional body field linking file to a planning entry.
     * @param projectId - Optional body field linking file to a project.
     * @param contractId - Optional body field linking file to a contract.
     *
     * At most ONE of `planningEntryId`/`projectId`/`contractId` may be provided - see
     * `FilesService.assertSingleParent()`.
     *
     * RATE LIMITING: uploads cost real disk I/O and storage space. `ThrottlerGuard` is no
     * longer global (see `app.module.ts`), so it is applied here explicitly with its own
     * budget, scoped to just this route.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 20, ttl: 60_000 } })
    @Post()
    @UseInterceptors(FileInterceptor('file', multerOptions))
    upload(
        @CurrentUser() actor: Actor,
        @UploadedFile() file: Express.Multer.File,
        @Body('planningEntryId') planningEntryId?: string,
        @Body('projectId') projectId?: string,
        @Body('contractId') contractId?: string,
    ) {
        return this.filesService.saveUploadedFile(actor, file, {
            planningEntryId: planningEntryId || undefined,
            projectId: projectId || undefined,
            contractId: contractId || undefined,
        });
    }

    /**
     * Endpoint for retrieving file metadata and verifying read access permissions.
     * * @param actor - The requesting authenticated user.
     * @param id - The unique file database ID.
     */
    @Get(':id')
    async getMetadata(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.filesService.assertCanAccess(actor, id);
    }

    /**
     * Secure file download endpoint.
     * Streams the physical file directly from disk after verifying user access permissions.
     * Sets proper security headers to prevent MIME sniffing and unsafe browser execution.
     * * @param actor - Requesting user.
     * @param id - Unique database file ID.
     * @param res - Express response object used for custom HTTP headers and streaming.
     */
    @Get(':id/download')
    async download(@CurrentUser() actor: Actor, @Param('id') id: string, @Res() res: Response) {
        // 1. Authorize actor access against file metadata before serving payload
        const file = await this.filesService.assertCanAccess(actor, id);
        const diskPath = this.filesService.resolveDiskPath(file.storedName);

        // 2. Ensure physical file exists on system storage disk before attempting read
        if (!fs.existsSync(diskPath)) {
            throw new NotFoundException('File missing from physical storage.');
        }

        /*
         * 3. Set Security & Content HTTP Headers:
         * - Content-Type: Serves the file with its native MIME type.
         * - Content-Disposition: Forces browser download ("attachment").
         *   SECURITY/CORRECTNESS FIX (audit #16): now built via `buildContentDisposition()`,
         *   which emits the RFC 5987-compliant `filename*=UTF-8''...` form alongside a plain
         *   ASCII fallback, instead of relying solely on a bare `encodeURIComponent()`d name.
         * - X-Content-Type-Options: "nosniff" stops browsers from executing non-JS files as code.
         */
        res.set({
            'Content-Type': file.mimeType,
            'Content-Disposition': buildContentDisposition(file.originalName),
            'X-Content-Type-Options': 'nosniff',
        });

        /*
         * 4. Perform Non-blocking Streaming Output:
         * Pipes file read stream directly to response socket to save memory overhead.
         */
        await streamFileToResponse(diskPath, res);
    }

    /**
     * Endpoint for deleting file records and corresponding physical storage files.
     * * @param actor - The authenticated user requesting deletion.
     * @param id - Target database file ID.
     */
    @Delete(':id')
    delete(@CurrentUser() actor: Actor, @Param('id') id: string) {
        return this.filesService.delete(actor, id);
    }
}