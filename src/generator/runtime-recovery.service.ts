import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';

export interface RecoveryReport {
    restored: string[];
    alreadyRunning: string[];
    failed: string[];
}

/**
 * RELIABILITY: brings generated backends back after the host (or Docker) restarted.
 *
 * Generated containers run with `--restart on-failure:5` (a crash loop must not run forever), and
 * that policy does NOT bring a container back after a host reboot or a Docker restart - so every
 * platform the owner had started used to stay offline until someone clicked "Start" again. The
 * database still says `RUNNING`/`STARTING` for those platforms (nothing had the chance to update
 * it), which is exactly the signal used here: a platform the owner left running whose container
 * is not running any more is started again, once, a few seconds after the orchestrator boots.
 *
 * What is deliberately NOT restored:
 *  - platforms the owner stopped (`STOPPED`) - that was an explicit decision;
 *  - platforms already recorded as `CRASHED`;
 *  - platforms whose container is still running (for example when only this stack was restarted).
 *
 * Each platform is tried at most once per round, sequentially (a build or a start is heavy), and
 * failing ones are retried a few times: right after a reboot the Docker API can answer a little
 * later than the orchestrator. Set `GENERATED_BACKEND_AUTO_RESTORE=false` to turn this off.
 * Single-instance design, like the rest of the runtime state: `start()` refuses a platform that is
 * already running, so a second instance would simply skip it.
 */
@Injectable()
export class RuntimeRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
    private readonly logger = new Logger(RuntimeRecoveryService.name);
    private timer?: NodeJS.Timeout;
    private stopped = false;

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
        private readonly runtime: DockerRuntimeManagerService,
    ) {}

    onApplicationBootstrap(): void {
        if (!this.isEnabled()) {
            this.logger.log(
                'Automatic restore of generated backends is disabled (GENERATED_BACKEND_AUTO_RESTORE=false).',
            );
            return;
        }
        const delayMs = Number(this.configService.get('GENERATED_BACKEND_RESTORE_DELAY_MS', 5000));
        // Never block application start-up: the HTTP API must come up even if Docker is slow.
        this.timer = setTimeout(() => void this.run(), delayMs);
        this.timer.unref?.();
    }

    onModuleDestroy(): void {
        this.stopped = true;
        if (this.timer) clearTimeout(this.timer);
    }

    private isEnabled(): boolean {
        return String(this.configService.get('GENERATED_BACKEND_AUTO_RESTORE', true)) !== 'false';
    }

    /** Runs the recovery with retries. Exposed for tests and for manual triggering. */
    async run(): Promise<RecoveryReport> {
        const attempts = Math.max(1, Number(this.configService.get('GENERATED_BACKEND_RESTORE_ATTEMPTS', 3)));
        const retryDelayMs = Number(this.configService.get('GENERATED_BACKEND_RESTORE_RETRY_DELAY_MS', 15_000));

        const report: RecoveryReport = { restored: [], alreadyRunning: [], failed: [] };
        let pending = await this.findCandidates();

        for (let attempt = 1; attempt <= attempts && pending.length > 0 && !this.stopped; attempt++) {
            const stillFailing: typeof pending = [];
            for (const platform of pending) {
                if (this.stopped) break;
                const outcome = await this.restoreOne(platform);
                if (outcome === 'restored') report.restored.push(platform.slug);
                else if (outcome === 'running') report.alreadyRunning.push(platform.slug);
                else stillFailing.push(platform);
            }
            pending = stillFailing;
            if (pending.length > 0 && attempt < attempts) {
                this.logger.warn(
                    `${pending.length} generated backend(s) could not be restored (attempt ${attempt}/${attempts}); retrying in ${Math.round(retryDelayMs / 1000)} s.`,
                );
                await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            }
        }

        report.failed = pending.map((p) => p.slug);
        if (report.restored.length || report.failed.length) {
            this.logger.log(
                `Generated backends recovery: restored=[${report.restored.join(', ')}] failed=[${report.failed.join(', ')}]`,
            );
        }
        return report;
    }

    private findCandidates() {
        return this.prisma.platform.findMany({
            where: {
                status: 'ACTIVE',
                runtimeStatus: { in: ['RUNNING', 'STARTING'] },
                generatedPort: { not: null },
            },
            select: { id: true, slug: true },
            orderBy: { createdAt: 'asc' },
        });
    }

    private async restoreOne(platform: { id: string; slug: string }): Promise<'restored' | 'running' | 'failed'> {
        try {
            const { status } = await this.runtime.getStatus(platform.id);
            if (status === 'RUNNING' || status === 'STARTING') return 'running';

            this.logger.log(`Restoring generated backend "${platform.slug}" (it was running before the restart)...`);
            await this.runtime.start(platform.id);
            return 'restored';
        } catch (error) {
            this.logger.warn(
                `Could not restore "${platform.slug}": ${error instanceof Error ? error.message : String(error)}`,
            );
            return 'failed';
        }
    }
}
