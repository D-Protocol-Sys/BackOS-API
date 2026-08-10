import {
    Controller, Post, Get, Delete, Param, Query, Body, UploadedFile, UseInterceptors, Res, NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { FilesService } from './files.service';
import { multerOptions } from './multer.config';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import * as fs from 'fs';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';

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
     */
    @Post()
    @UseInterceptors(FileInterceptor('file', multerOptions))
    upload(
        @CurrentUser() actor: Actor,
        @UploadedFile() file: Express.Multer.File,
        @Body('planningEntryId') planningEntryId?: string,
    ) {
        return this.filesService.saveUploadedFile(actor, file, planningEntryId || undefined);
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
         * - Content-Disposition: Forces browser download ("attachment") and escapes original filename.
         * - X-Content-Type-Options: "nosniff" stops browsers from executing non-JS files as code.
         */
        res.set({
            'Content-Type': file.mimeType,
            'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalName)}"`,
            'X-Content-Type-Options': 'nosniff',
        });

        /*
         * 4. Perform Non-blocking Streaming Output:
         * Pipes file read stream directly to response socket to save memory overhead.
         */
        fs.createReadStream(diskPath).pipe(res);
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