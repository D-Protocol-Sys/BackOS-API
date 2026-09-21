import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { GenerationStatus, Prisma } from '@prismamodels/client';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformsService } from '../platforms/platforms.service';
import { ClientsService } from '../clients/clients.service';

/**
 * Service responsible for scheduled background maintenance and database pruning tasks.
 * Helps prevent database bloat by removing stale or temporary records.
 */
@Injectable()
export class CleanupService {
    // Instantiates NestJS logger for standard output logging
    private readonly logger = new Logger(CleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly platforms: PlatformsService,
        private readonly clients: ClientsService,
    ) {}

    /**
     * Scheduled Cron Job: Executes daily database maintenance.
     * * @Cron(CronExpression.EVERY_DAY_AT_3AM) - Automates execution at 03:00 AM daily
     * when server traffic is typically lowest.
     */
    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async runDailyCleanup(): Promise<void> {
        const startedAt = Date.now();
        this.logger.log('Starting daily cleanup...');

        let totalDeleted = 0;
        
        // Sequential execution of distinct domain cleanup subroutines
        totalDeleted += await this.cleanupInvitations();
        totalDeleted += await this.cleanupRefreshTokens();
        totalDeleted += await this.cleanupRecoveryCodes();
        totalDeleted += await this.cleanupGenerations();
        totalDeleted += await this.cleanupBackupDumps();
        totalDeleted += await this.cleanupArchivedPlatforms();
        totalDeleted += await this.cleanupArchivedClients();
        totalDeleted += await this.cleanupArchivedContracts();

        const durationMs = Date.now() - startedAt;
        this.logger.log(
            `Daily cleanup completed successfully. ` +
            `${totalDeleted} record(s)/file(s) deleted in ${durationMs}ms.`,
        );
    }

    /**
     * Purges stale invitation records.
     * Deletes:
     * 1. Unused invitations that passed their expiration date (plus retention buffer).
     * 2. Already used invitations past their retention cutoff date.
     * * @returns The count of deleted invitation records.
     */
    private async cleanupInvitations(): Promise<number> {
        try {
            // Retrieves retention window in days, falling back to 7 days if unconfigured
            const retentionDays = this.getPositiveIntegerConfig(
                'OTP_CLEANUP_RETENTION_DAYS',
                7,
            );
            const cutoff = this.getCutoffDate(retentionDays);

            // Batch deletion using Prisma OR condition
            const result = await this.prisma.invitation.deleteMany({
                where: {
                    OR: [
                        {
                            expiresAt: {
                                lt: cutoff, // Expired before the cutoff date
                            },
                        },
                        {
                            used: true,
                            usedAt: {
                                lt: cutoff, // Used before the cutoff date
                            },
                        },
                    ],
                },
            });

            if (result.count > 0) {
                this.logger.log(
                    `Invitations cleanup: ${result.count} record(s) deleted.`,
                );
            } else {
                this.logger.debug(
                    'Invitations cleanup: nothing to delete.',
                );
            }

            return result.count;
        } catch (error) {
            // Safe error handling ensures failure here doesn't break subsequent cleanup steps
            this.logCleanupError('invitations', error);
            return 0;
        }
    }

    /**
     * Purges invalid and inactive refresh tokens past the retention threshold.
     * Deletes tokens that are either explicitly revoked or naturally expired.
     * * @returns The count of deleted refresh token records.
     */
    private async cleanupRefreshTokens(): Promise<number> {
        try {
            const retentionDays = this.getPositiveIntegerConfig(
                'REFRESH_TOKEN_CLEANUP_RETENTION_DAYS',
                30,
            );

            const cutoff = this.getCutoffDate(retentionDays);

            const result = await this.prisma.refreshToken.deleteMany({
                where: {
                    OR: [
                        {
                            expiresAt: {
                                lt: cutoff, // Expired before the retention window
                            },
                        },
                        {
                            revokedAt: {
                                lt: cutoff, // Manually revoked before the retention window
                            },
                        },
                    ],
                },
            });

            if (result.count > 0) {
                this.logger.log(
                    `Refresh token cleanup: ${result.count} record(s) deleted.`,
                );
            } else {
                this.logger.debug(
                    'Refresh token cleanup: nothing to delete.',
                );
            }

            return result.count;
        } catch (error) {
            this.logCleanupError('refresh tokens', error);
            return 0;
        }
    }

    /**
     * Purges consumed Multi-Factor Authentication (MFA) recovery codes.
     * Note: Unused recovery codes are strictly preserved.
     * * @returns The count of deleted consumed recovery codes.
     */
    private async cleanupRecoveryCodes(): Promise<number> {
        try {
            const retentionDays = this.getPositiveIntegerConfig(
                'RECOVERY_CODE_CLEANUP_RETENTION_DAYS',
                30,
            );

            const cutoff = this.getCutoffDate(retentionDays);

            const result = await this.prisma.recoveryCode.deleteMany({
                where: {
                    usedAt: {
                        lt: cutoff, // Used prior to the retention cutoff
                    },
                },
            });

            if (result.count > 0) {
                this.logger.log(
                    `Recovery code cleanup: ${result.count} record(s) deleted.`,
                );
            } else {
                this.logger.debug(
                    'Recovery code cleanup: nothing to delete.',
                );
            }

            return result.count;
        } catch (error) {
            this.logCleanupError('recovery codes', error);
            return 0;
        }
    }

    /**
     * Purges historic generation records.
     * Preserves active processes (PENDING/RUNNING) and only purges completed terminal states (SUCCESS/FAILED).
     * * @returns The count of deleted generation records.
     */
    private async cleanupGenerations(): Promise<number> {
        try {
            const retentionDays = this.getPositiveIntegerConfig(
                'GENERATION_CLEANUP_RETENTION_DAYS',
                30,
            );

            const cutoff = this.getCutoffDate(retentionDays);

            const result = await this.prisma.generation.deleteMany({
                where: {
                    status: {
                        in: [
                            GenerationStatus.SUCCESS,
                            GenerationStatus.FAILED,
                        ],
                    },
                    finishedAt: {
                        not: null, // Guarantees the task has concluded
                        lt: cutoff,
                    },
                },
            });

            if (result.count > 0) {
                this.logger.log(
                    `Generation cleanup: ${result.count} record(s) deleted.`,
                );
            } else {
                this.logger.debug(
                    'Generation cleanup: nothing to delete.',
                );
            }

            return result.count;
        } catch (error) {
            this.logCleanupError('generations', error);
            return 0;
        }
    }

    /**
     * Permanently deletes any platform that has been continuously ARCHIVED for longer than the
     * configured retention window (default 30 days) - see `PlatformsService.archive()` for how
     * that countdown is started, and `PlatformsService.restore()`/`archive()` for why
     * unarchiving-then-rearchiving always restarts it from zero rather than resuming it.
     *
     * Unlike this service's other cleanup subroutines, this one delegates to
     * `PlatformsService.purgeExpiredArchives()` instead of running a plain Prisma `deleteMany`
     * directly: permanently deleting a platform has real side effects beyond the database row
     * (stopping its Docker runtime if still running, removing its generated project directory
     * from disk) that only `PlatformsService` has the collaborators to perform correctly.
     * * @returns The count of platforms permanently deleted.
     */
    private async cleanupArchivedPlatforms(): Promise<number> {
        try {
            const retentionDays = this.getPositiveIntegerConfig(
                'PLATFORM_ARCHIVE_RETENTION_DAYS',
                30,
            );

            const purgedCount = await this.platforms.purgeExpiredArchives(retentionDays);

            if (purgedCount > 0) {
                this.logger.log(
                    `Archived platform cleanup: ${purgedCount} platform(s) permanently deleted ` +
                    `after ${retentionDays} consecutive day(s) archived.`,
                );
            } else {
                this.logger.debug('Archived platform cleanup: nothing to delete.');
            }

            return purgedCount;
        } catch (error) {
            this.logCleanupError('archived platforms', error);
            return 0;
        }
    }

    /**
     * Permanently deletes any client that has been continuously ARCHIVED for longer than the
     * configured retention window (default 30 days) - same mechanism as
     * `cleanupArchivedPlatforms()` above, see `ClientsService.archive()`/`restore()` for how
     * the countdown works. Purging a client also purges every one of its contracts (and their
     * attached files) - see `ClientsService.purgeClientInternal()`.
     * * @returns The count of clients permanently deleted.
     */
    private async cleanupArchivedClients(): Promise<number> {
        try {
            const retentionDays = this.getPositiveIntegerConfig(
                'CLIENT_ARCHIVE_RETENTION_DAYS',
                30,
            );

            const purgedCount = await this.clients.purgeExpiredArchives(retentionDays);

            if (purgedCount > 0) {
                this.logger.log(
                    `Archived client cleanup: ${purgedCount} client(s) permanently deleted ` +
                    `after ${retentionDays} consecutive day(s) archived.`,
                );
            } else {
                this.logger.debug('Archived client cleanup: nothing to delete.');
            }

            return purgedCount;
        } catch (error) {
            this.logCleanupError('archived clients', error);
            return 0;
        }
    }

    /**
     * Permanently deletes any contract that has been continuously ARCHIVED for longer than the
     * configured retention window (default 30 days) - independently of its client's own
     * archive state, since a contract can be archived on its own (see `ClientsService.
     * archiveContract()`). Deleting an already-archived client purges its contracts
     * immediately regardless of this window (see `cleanupArchivedClients()` above); this
     * subroutine only ever catches contracts archived on their own.
     * * @returns The count of contracts permanently deleted.
     */
    private async cleanupArchivedContracts(): Promise<number> {
        try {
            const retentionDays = this.getPositiveIntegerConfig(
                'CONTRACT_ARCHIVE_RETENTION_DAYS',
                30,
            );

            const purgedCount = await this.clients.purgeExpiredContractArchives(retentionDays);

            if (purgedCount > 0) {
                this.logger.log(
                    `Archived contract cleanup: ${purgedCount} contract(s) permanently deleted ` +
                    `after ${retentionDays} consecutive day(s) archived.`,
                );
            } else {
                this.logger.debug('Archived contract cleanup: nothing to delete.');
            }

            return purgedCount;
        } catch (error) {
            this.logCleanupError('archived contracts', error);
            return 0;
        }
    }

    /**
     * SECURITY FIX (audit #6 - elevated): purges stale database dump files (`.sql.gz`) left on
     * disk under `BACKUP_OUTPUT_DIR` by `POST /backup/platforms`.
     *
     * Before this fix, `BackupController.dumpAllPlatforms()` had no download route at all -
     * every dump it produced stayed on disk forever, with no application-level inventory or
     * limit (see `BackupService`/`BackupController` for the accompanying fix that added
     * `GET /backup/download`). This method is the backstop for the case a dump is produced but
     * never actually downloaded (script failure, admin forgets, etc.) - it is a disk-space and
     * data-retention safety net, not the primary cleanup path (a successful download already
     * deletes its own file immediately via `BackupController`'s `streamAndCleanup()`).
     *
     * Deliberately scans the filesystem rather than a database table, since dumps are files,
     * not rows - there is no `BackupDump` model to query. Only files matching the exact naming
     * pattern this service produces (`<label>_<timestamp>.sql.gz`) are ever touched, so this
     * can't accidentally delete an unrelated file that happens to live in the same directory.
     * * @returns The count of deleted dump files.
     */
    private async cleanupBackupDumps(): Promise<number> {
        try {
            const retentionHours = this.getPositiveIntegerConfig(
                'BACKUP_DUMP_RETENTION_HOURS',
                48,
            );
            const outputDir = this.resolveBackupOutputDir();
            const cutoffMs = Date.now() - retentionHours * 60 * 60 * 1000;

            let entries: string[];
            try {
                entries = await fs.readdir(outputDir);
            } catch (error) {
                // Directory not existing yet (no dump has ever been produced) is normal, not
                // an error - nothing to clean up.
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                    return 0;
                }
                throw error;
            }

            let deletedCount = 0;

            for (const entry of entries) {
                // Only ever touch files this service itself could have produced - see
                // `BackupService.sanitizeLabel()` / `resolveDumpPath()` for the matching
                // filename contract on the write/download side.
                if (!/^[a-zA-Z0-9-_]+\.sql\.gz$/.test(entry)) {
                    continue;
                }

                const fullPath = path.join(outputDir, entry);

                try {
                    const stats = await fs.stat(fullPath);
                    if (stats.birthtimeMs < cutoffMs) {
                        await fs.unlink(fullPath);
                        deletedCount++;
                    }
                } catch (error) {
                    // A file disappearing between readdir and stat/unlink (e.g. concurrently
                    // downloaded and self-cleaned by BackupController) is not a failure.
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error;
                    }
                }
            }

            if (deletedCount > 0) {
                this.logger.log(
                    `Backup dump cleanup: ${deletedCount} unclaimed dump file(s) deleted.`,
                );
            } else {
                this.logger.debug('Backup dump cleanup: nothing to delete.');
            }

            return deletedCount;
        } catch (error) {
            this.logCleanupError('backup dumps', error);
            return 0;
        }
    }

    /**
     * Resolves `BACKUP_OUTPUT_DIR` the same way `BackupService.resolveOutputDir()` does
     * (relative paths are resolved against the process working directory), so this cleans up
     * exactly the directory dumps are actually written to.
     */
    private resolveBackupOutputDir(): string {
        const configured = this.configService.get<string>('BACKUP_OUTPUT_DIR', 'backups');
        return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
    }

    /**
     * Utility: Calculates a historical Date instance by subtracting the retention period in days from the current timestamp.
     * * @param retentionDays - The number of days to look back.
     * @returns The calculated threshold Cutoff Date.
     */
    private getCutoffDate(retentionDays: number): Date {
        return new Date(
            Date.now() - retentionDays * 24 * 60 * 60 * 1000,
        );
    }

    /**
     * Utility: Safely reads and validates numerical environment configuration parameters.
     * Falls back gracefully to default values when configs are missing, malformed, or non-positive.
     * * @param key - The Environment variable key name.
     * @param defaultValue - Safe fallback integer value.
     */
    private getPositiveIntegerConfig(
        key: string,
        defaultValue: number,
    ): number {
        const value = this.configService.get<string | number>(key);

        if (value === undefined || value === null || value === '') {
            return defaultValue;
        }

        const parsed = Number(value);

        // Rejects NaN, floating point numbers, and non-positive values
        if (!Number.isInteger(parsed) || parsed <= 0) {
            this.logger.warn(
                `Invalid cleanup configuration "${key}"="${value}". ` +
                `Using safe default: ${defaultValue}.`,
            );

            return defaultValue;
        }

        return parsed;
    }

    /**
     * Utility: Formats and logs errors caught during maintenance execution.
     * Differentiates Prisma ORM errors from standard runtime JavaScript Errors.
     */
    private logCleanupError(
        resource: string,
        error: unknown,
    ): void {
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
            this.logger.error(
                `Cleanup failed for ${resource}. ` +
                `Prisma error code: ${error.code}.`,
            );

            return;
        }

        if (error instanceof Error) {
            this.logger.error(
                `Cleanup failed for ${resource}: ${error.message}`,
            );

            return;
        }

        this.logger.error(
            `Cleanup failed for ${resource}: unknown error.`,
        );
    }
    
}