import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformServicesService } from './platform-services.service';
import { GENERATED_BACKEND_API_PREFIX } from './generated-backend.constants';

/**
 * Tells a RUNNING generated backend "the list of internal accounts changed, pull it again", so a
 * role change in BackOS (member added / role changed / member removed / a role's permissions
 * edited) takes effect on the generated backend immediately - no restart, no regeneration.
 *
 * The notification carries NO data: the generated backend calls back
 * `POST /api/internal/generated-auth/internal-accounts` on BackOS (authenticated with the
 * platform's own `internalAuthKey`) and reconciles its accounts with that answer. So the ping
 * cannot be abused to inject accounts - worst case a forged ping makes the backend re-read the
 * truth from BackOS.
 *
 * Strictly best-effort and never throws: BackOS's own operation (adding a member...) must not
 * fail because a generated backend is stopped or unreachable. A backend that is down simply
 * pulls the current list itself the next time it starts.
 */
@Injectable()
export class InternalAccountsSyncService {

    private readonly logger = new Logger(InternalAccountsSyncService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly platformServices: PlatformServicesService,
        private readonly configService: ConfigService,
    ) {}

    /** Fire-and-forget friendly: resolves once the attempt is over, never rejects. */
    async notify(platformId: string): Promise<void> {
        try {
            const platform = await this.prisma.platform.findUnique({
                where: { id: platformId },
                select: { slug: true, generatedPort: true, runtimeStatus: true },
            });
            if (!platform?.generatedPort) return;
            if (platform.runtimeStatus !== 'RUNNING' && platform.runtimeStatus !== 'STARTING') return;

            // No `auth-user` service (or no key yet) means there are no internal accounts to sync.
            const config = await this.platformServices.getFullDecryptedConfig(platformId, 'auth-user').catch(() => null);
            const internalKey = config?.internalAuthKey;
            if (typeof internalKey !== 'string' || internalKey.length === 0) return;

            // RT-003: same address as the gateway and the health check - GENERATED_BACKEND_HOST is the
            // bind address INSIDE the host, unreachable when the orchestrator itself runs in a container.
            const host = this.configService.get<string>('GENERATED_BACKEND_GATEWAY_HOST')
                || this.configService.get<string>('GENERATED_BACKEND_HOST', '127.0.0.1');
            const response = await fetch(
                `http://${host}:${platform.generatedPort}/${GENERATED_BACKEND_API_PREFIX}/auth/internal/sync`,
                {
                    method: 'POST',
                    headers: { 'X-Backos-Internal-Key': internalKey },
                    signal: AbortSignal.timeout(8000),
                },
            );

            if (!response.ok) {
                // 404 = a backend generated before this feature existed: it picks the change up
                // at its next generation. Not an error worth shouting about.
                this.logger.warn(`Internal accounts sync for "${platform.slug}" answered ${response.status}.`);
            }
        } catch (error) {
            this.logger.warn(
                `Could not notify the generated backend of ${platformId} to resync its internal accounts: ` +
                (error instanceof Error ? error.message : String(error)),
            );
        }
    }

}
