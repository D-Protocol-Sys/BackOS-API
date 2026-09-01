import { Controller, Post, Param, Res, NotFoundException, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import * as fs from 'fs';
import { BackupService } from './backup.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';

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
     */
    @RequirePermissions(PERMISSIONS.BACKUP_MANAGE)
    @Post('platforms')
    async dumpAllPlatforms() {
        const { succeeded, failed } = await this.backupService.dumpAllPlatformDatabases();
        return {
            dumps: succeeded.map((d) => ({ fileName: d.fileName, filePath: d.filePath, sizeBytes: d.sizeBytes, createdAt: d.createdAt })),
            failures: failed,
        };
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
            'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
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
