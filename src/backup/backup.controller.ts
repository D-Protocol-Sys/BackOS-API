import { Controller, Post, Get, Param, Query, Res, NotFoundException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import * as fs from 'fs';
import { BackupService } from './backup.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { buildContentDisposition } from '../common/utils/content-disposition.util';

/**
 * Admin-only endpoints to export ("dump") a database to a downloadable, gzip-compressed SQL
 * file - see `BackupService` for the full rationale (infra migration, disaster recovery).
 *
 * Deliberately gated on the single global `BACKUP_MANAGE` permission for every route here,
 * unlike `GeneratorController`'s per-platform owner/admin-member checks: a database dump is a
 * full, unfiltered export of everything in that database, so "this platform's ADMIN member"
 * being enough to trigger one is a materially bigger exposure than the runtime-management
 * actions that pattern was designed for. This is intentionally an infra-operator action, not a
 * platform-owner one.
 *
 * RATE LIMITING: `pg_dump` is real disk I/O and CPU cost, run on demand - the same class of
 * expensive route `app.module.ts` calls out as deserving its own scoped throttle budget
 * (alongside file uploads and generation triggers), separate from the ordinary GET/list routes
 * that intentionally aren't throttled at all. A tighter budget than uploads is used here
 * because a full database export is heavier than a single file write.
 */
@UseGuards(ThrottlerGuard)
@Throttle({ default: { limit: 5, ttl: 60_000 } })
@ApiTags('Backup')
@ApiBearerAuth('access-token')
@Controller('backup')
export class BackupController {
    constructor(private readonly backupService: BackupService) {}

    /**
     * Dumps and downloads the orchestrator's own database (users, platforms, permissions,
     * generation history, ...).
     */
    @RequirePermissions(PERMISSIONS.BACKUP_MANAGE)
    @Post('orchestrator')
    async dumpOrchestrator(@Res() res: Response) {
        const dump = await this.backupService.dumpOrchestratorDatabase();
        await this.streamAndCleanup(dump.filePath, dump.fileName, res);
    }

    /**
     * Dumps and downloads a single generated platform's own database.
     */
    @RequirePermissions(PERMISSIONS.BACKUP_MANAGE)
    @Post('platforms/:platformId')
    async dumpPlatform(@Param('platformId') platformId: string, @Res() res: Response) {
        const dump = await this.backupService.dumpPlatformDatabase(platformId);
        await this.streamAndCleanup(dump.filePath, dump.fileName, res);
    }

    /**
     * Dumps every provisioned platform database sequentially. Since this can produce several
     * files and take a while, this endpoint does NOT stream a download - it returns a JSON
     * summary (what succeeded, what failed and why, and the size of each dump) so a script or
     * an admin can decide what to do next, rather than tying up the HTTP response streaming an
     * arbitrarily large multi-file payload.
     *
     * SECURITY FIX (audit #6 - elevated): previously returned each dump's absolute server-side
     * `filePath`, with NO route anywhere that accepted it to actually download (or clean up)
     * the file - `streamAndCleanup()` was only ever wired to the single-platform/orchestrator
     * routes. That meant every call here left N `.sql.gz` files (each a full, unfiltered export
     * of a platform's database) accumulating on disk indefinitely, discoverable only by
     * directly accessing the server's filesystem. This now returns just `fileName` (see
     * `download()` below, and `BackupService.resolveDumpPath()` for why a bare name rather than
     * a path), and `CleanupService` now purges any dump left unclaimed past a retention window
     * (see `cleanup.service.ts`) as a backstop for dumps nobody ever downloads.
     */
    @RequirePermissions(PERMISSIONS.BACKUP_MANAGE)
    @Post('platforms')
    async dumpAllPlatforms() {
        const { succeeded, failed } = await this.backupService.dumpAllPlatformDatabases();
        return {
            dumps: succeeded.map((d) => ({ fileName: d.fileName, sizeBytes: d.sizeBytes, createdAt: d.createdAt })),
            failures: failed,
        };
    }

    /**
     * Downloads (and then deletes) a dump file previously produced by `dumpAllPlatforms()`.
     * SECURITY FIX (audit #6): this is the missing route referenced above - `fileName` is
     * strictly validated and re-resolved server-side by `BackupService.resolveDumpPath()`
     * (never trusted as a raw path), so this cannot be used to read arbitrary files off disk.
     */
    @RequirePermissions(PERMISSIONS.BACKUP_MANAGE)
    @Get('download')
    async download(@Query('fileName') fileName: string, @Res() res: Response) {
        const filePath = this.backupService.resolveDumpPath(fileName);
        await this.streamAndCleanup(filePath, fileName, res);
    }

    /**
     * Streams a dump file already produced by `dumpAllPlatforms()` (or any dump whose path you
     * already know) back as a download, then deletes it - see `BackupService`'s class-level
     * comment for why dumps aren't retained after being handed off.
     */
    private async streamAndCleanup(filePath: string, fileName: string, res: Response): Promise<void> {
        if (!fs.existsSync(filePath)) {
            throw new NotFoundException('Dump file missing from disk.');
        }

        res.set({
            'Content-Type': 'application/gzip',
            // SECURITY/CORRECTNESS FIX (audit #16): RFC 5987-compliant filename encoding -
            // see `buildContentDisposition()`'s doc comment.
            'Content-Disposition': buildContentDisposition(fileName),
            'X-Content-Type-Options': 'nosniff',
        });

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        // Cleanup runs once the response is fully sent (or the connection drops) - either way
        // the file has already been handed off (or abandoned) and doesn't need to linger.
        res.on('close', () => {
            void this.backupService.deleteDump(filePath);
        });
    }
}
