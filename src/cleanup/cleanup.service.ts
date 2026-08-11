import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { GenerationStatus, Prisma } from '@prismamodels/client';
import { PrismaService } from '../prisma/prisma.service';

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

        const durationMs = Date.now() - startedAt;
        this.logger.log(
            `Daily cleanup completed successfully. ` +
            `${totalDeleted} record(s) deleted in ${durationMs}ms.`,
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