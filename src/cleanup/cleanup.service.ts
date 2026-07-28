import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class CleanupService {

    private readonly logger = new Logger(CleanupService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async cleanupExpiredOtpCodes() {
        const retentionDays = this.configService.get<number>('OTP_CLEANUP_RETENTION_DAYS', 7);
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const result = await this.prisma.otpCode.deleteMany({
            where: { createdAt: { lt: cutoff } },
        });

        if (result.count > 0) {
            this.logger.log(`${result.count} code(s) OTP obsolète(s) supprimé(s).`);
        }
    }

    @Cron(CronExpression.EVERY_DAY_AT_3AM)
    async cleanupExpiredRefreshTokens() {

        const retentionDays = this.configService.get<number>(
            'REFRESH_TOKEN_CLEANUP_RETENTION_DAYS',
            30,
        );
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

        const result = await this.prisma.refreshToken.deleteMany({
            where: {
                OR: [{ expiresAt: { lt: cutoff } }, { revokedAt: { lt: cutoff } }],
            },
        });

        if (result.count > 0) {
            this.logger.log(`${result.count} refresh token(s) obsolète(s) supprimé(s).`);
        }
    }
}