import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GENERATION_QUEUE_NAME, GENERATION_JOB_RETENTION } from './generator-queue.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { GenerationsService } from './generations.service';
import {
    runCommand,
    CommandFailedError,
    CommandCancelledError,
    redactSecrets,
} from '../common/utils/command-runner.util';
import { PortAllocatorService } from './port-allocator.service';
import { GenerationCancellationRegistry } from './generation-cancellation.registry';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'pg';
import { findDestructiveStatements } from './migration-safety.util';

/**
 * Interface defining the payload structure for background project generation jobs handled by BullMQ.
 */
export interface GenerationJobData {
    platformId: string;
    slug: string;
    generationId: string;
    /**
     * How many times this same generation has already been auto-restarted after being
     * orphaned by a server restart (as opposed to a genuine error thrown by `process()`, which
     * fails immediately and is never auto-restarted - see the RUNNING-status guard in
     * `onJobFailed`). Absent/0 on the first, user-triggered run. Capped by
     * `GENERATION_MAX_AUTO_RESTARTS` so a machine stuck in a crash loop can't retry forever.
     */
    restartCount?: number;
    /**
     * GEN-001: set only by the platform owner (or a global generator.execute holder) when they
     * explicitly accept that this generation applies destructive SQL (DROP COLUMN/TABLE, type
     * changes...). Absent/false = any destructive statement makes the generation fail BEFORE
     * anything is applied to the live database.
     */
    allowDestructiveMigration?: boolean;
}

/**
 * BullMQ Worker Processor executing the automated platform code generation pipeline asynchronously.
 * It manages database provisioning, dynamic project scaffolding, package installation, database migrations, and TypeScript compilation.
 */
@Processor(GENERATION_QUEUE_NAME, {
    // Explicit rather than relying on BullMQ's implicit defaults (which happen to be the same
    // values today, but silently inherit whatever the library's defaults become tomorrow):
    // - lockDuration: how long a job can go without its lock being renewed (renewal is
    //   automatic and happens every ~lockDuration/2 while `process()` is alive) before it's
    //   eligible to be considered stalled. 30s is short enough to detect a dead worker quickly
    //   without false-positiving on brief event-loop stalls during heavy `pnpm install`/`build`
    //   I/O.
    // - maxStalledCount: how many times a job may be detected stalled and requeued before
    //   BullMQ gives up on it for good. 2 (rather than the default 1) buys one extra automatic
    //   retry - useful since "the main backend restarts" can plausibly happen twice in a row
    //   (e.g. a crash loop) - before `onJobFailed` below takes over and reflects the failure
    //   back onto the generation/platform records instead of leaving them stuck.
    lockDuration: 30_000,
    maxStalledCount: 2,
})
export class GenerationProcessor extends WorkerHost implements OnApplicationBootstrap {
    private readonly logger = new Logger(GenerationProcessor.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly provisioning: ProvisioningService,
        private readonly scaffolder: ProjectScaffolderService,
        private readonly generations: GenerationsService,
        private readonly portAllocator: PortAllocatorService,
        private readonly configService: ConfigService,
        private readonly cancellationRegistry: GenerationCancellationRegistry,
        private readonly dockerRuntime: DockerRuntimeManagerService,
        @InjectQueue(GENERATION_QUEUE_NAME) private readonly queue: Queue<GenerationJobData>,
    ) {
        super();
    }

    /**
     * Startup safety net. If this process (or a previous one) died mid-generation - the exact
     * scenario reported: "le back principal redémarre pendant la génération" - the `finally`/
     * `catch` block at the bottom of `process()` never runs, so `generation.status` stays stuck
     * at RUNNING and `platform.status` stays stuck at GENERATING forever: nothing else ever
     * updates them.
     *
     * BullMQ itself will often recover the *job* automatically (stalled-job detection requeues
     * it, and this pipeline is idempotent - see the STEP 3 comment on `scaffold()` wiping/
     * recreating the project directory). But if it stalls twice (`maxStalledCount` defaults to
     * 1) BullMQ gives up on the job at the queue level *without ever calling `process()` again*,
     * and if Redis itself lost track of the job (flushed, restarted alongside the main backend,
     * TTL'd), there is nothing left in the queue to even detect. Either way, our own DB record
     * is left orphaned with no signal anywhere that something went wrong - so this is also the
     * path that auto-restarts a generation whose job vanished entirely from Redis, which
     * `onJobFailed` below can never see fire since there's no job left to emit an event.
     *
     * Runs once per boot: finds every generation stuck at RUNNING and checks whether the queue
     * still has a live claim on it before deciding it's truly orphaned.
     */
    async onApplicationBootstrap(): Promise<void> {
        await this.reconcileOrphanedGenerations();
    }

    private async reconcileOrphanedGenerations(): Promise<void> {
        await this.reconcileOrphanedPendingGenerations();

        const stuck = await this.prisma.generation.findMany({
            where: { status: 'RUNNING' },
            select: { id: true, platformId: true },
        });
        if (stuck.length === 0) return;

        for (const generation of stuck) {
            // jobId is set to the generation's own id when enqueued (see
            // `generator.controller.ts`), so this is a direct lookup, not a search.
            const job = await this.queue.getJob(generation.id);
            const state = job ? await job.getState() : null;

            // Genuinely still queued/active: leave it alone. Either another worker instance is
            // legitimately processing it, or BullMQ's stalled-job detection will resume or
            // (eventually) fail it, which `onJobFailed` below will then reconcile.
            if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'waiting-children') {
                continue;
            }

            this.logger.warn(
                `Reconciling orphaned generation ${generation.id} (queue state: ${state ?? 'absent from queue'}).`,
            );
            // Redis lost this job entirely (state === null): its data, including restartCount,
            // is gone with it. Fall back to the DB's platformId + a fresh lookup of the
            // platform's slug (not stored on Generation) and treat it as restart #0 - there's
            // no way to know how many auto-restarts happened before a total Redis loss, so this
            // one case can't be capped as tightly as the normal `onJobFailed` path below.
            const restartCount = job?.data?.restartCount ?? 0;
            const platform = job
                ? null
                : await this.prisma.platform.findUnique({
                      where: { id: generation.platformId },
                      select: { slug: true },
                  });
            if (!job && !platform) {
                // Platform itself is gone too - nothing sane to restart.
                await this.markAsFailed(
                    generation.id,
                    generation.platformId,
                    'Interrompue par un redémarrage du serveur : plateforme introuvable, merci de relancer manuellement.',
                );
                continue;
            }

            await this.restartOrFail(
                generation.id,
                generation.platformId,
                job?.data?.slug ?? platform!.slug,
                restartCount,
            );
        }
    }

    /**
     * RELIABILITY FIX (QUEUE-002): a generation row is created PENDING before its job is added to
     * the queue. If Redis was down at that moment (or the process died in between), the row stayed
     * PENDING forever and `hasActiveGeneration()` then refused every future generation of that
     * platform. Such orphans are re-enqueued at boot (same jobId, so never duplicated).
     */
    private async reconcileOrphanedPendingGenerations(): Promise<void> {
        const pending = await this.prisma.generation.findMany({
            where: { status: 'PENDING' },
            select: { id: true, platformId: true, platform: { select: { slug: true, status: true } } },
        });
        for (const generation of pending) {
            const job = await this.queue.getJob(generation.id);
            if (job) continue;
            if (!generation.platform || generation.platform.status === 'ARCHIVED') {
                await this.generations
                    .markFailed(generation.id, 'Plateforme archivée ou introuvable : génération abandonnée.')
                    .catch(() => undefined);
                continue;
            }
            this.logger.warn(`Re-enqueuing orphaned PENDING generation ${generation.id}.`);
            await this.queue.add(
                'generate',
                {
                    platformId: generation.platformId,
                    slug: generation.platform.slug,
                    generationId: generation.id,
                } satisfies GenerationJobData,
                { jobId: generation.id, ...GENERATION_JOB_RETENTION },
            );
        }
    }

    /**
     * Fires whenever BullMQ finalizes a job as failed - including failures it decided on its
     * own (e.g. a stalled job that exceeded `maxStalledCount`), which never go through the
     * `try/catch` in `process()` because the worker that owned the job is already gone. Errors
     * thrown *inside* `process()` also land here, but those are already handled synchronously
     * (and marked FAILED directly, with no auto-restart - a real application error isn't a
     * "server restarted" situation) before the promise rejects, so the guard below (status
     * still RUNNING) makes this a no-op for that case.
     */
    @OnWorkerEvent('failed')
    async onJobFailed(job: Job<GenerationJobData> | undefined, error: Error): Promise<void> {
        if (!job?.data?.generationId) return;
        const { generationId, platformId, slug, restartCount } = job.data;

        const current = await this.prisma.generation.findUnique({
            where: { id: generationId },
            select: { status: true },
        });
        if (!current || current.status !== 'RUNNING') return; // already handled by process()'s own catch block

        this.logger.error(`Generation ${generationId} failed at the queue level (orphaned/stalled job).`, error?.stack);
        await this.restartOrFail(generationId, platformId, slug, restartCount ?? 0);
    }

    /**
     * Central auto-restart decision, shared by both recovery paths above. Re-enqueues the same
     * generation as a fresh job (same `jobId`, so it keeps showing up as the same generation
     * record everywhere in the UI) up to `GENERATION_MAX_AUTO_RESTARTS` times; beyond that it
     * gives up and marks the generation FAILED so a real, persistent problem doesn't retry
     * forever and hide behind an endless "GENERATING" state.
     */
    private async restartOrFail(
        generationId: string,
        platformId: string,
        slug: string,
        restartCount: number,
    ): Promise<void> {
        const maxAutoRestarts = this.configService.get<number>('GENERATION_MAX_AUTO_RESTARTS', 3);

        if (restartCount >= maxAutoRestarts) {
            await this.markAsFailed(
                generationId,
                platformId,
                `Interrompue par des redémarrages répétés du serveur (${restartCount} tentatives automatiques épuisées). Merci de relancer la génération manuellement.`,
            );
            return;
        }

        const nextRestartCount = restartCount + 1;
        this.logger.warn(
            `Auto-restarting generation ${generationId} (attempt ${nextRestartCount}/${maxAutoRestarts}) after an interrupted run.`,
        );

        try {
            // A job with this id may still exist in the queue (in 'failed' state) - BullMQ
            // refuses to add a new job under an id that's already taken, so it has to be
            // cleared first. Harmless no-op if it's already gone (e.g. the Redis-loss path in
            // reconcileOrphanedGenerations, where there's nothing to remove).
            const existingJob = await this.queue.getJob(generationId);
            if (existingJob) await existingJob.remove();

            await this.generations.appendLog(
                generationId,
                `↻ Génération interrompue par un redémarrage du serveur - relance automatique (tentative ${nextRestartCount}/${maxAutoRestarts})...`,
            );

            await this.queue.add(
                'generate',
                { platformId, slug, generationId, restartCount: nextRestartCount } satisfies GenerationJobData,
                { jobId: generationId, ...GENERATION_JOB_RETENTION },
            );
            // Deliberately left at whatever status it was in (RUNNING) and platform stays
            // GENERATING: from the user's point of view the generation never stopped, it's
            // just picked back up. `process()` will call `markRunning()` again once it does.
        } catch (e: unknown) {
            this.logger.error(
                `Failed to auto-restart generation ${generationId}; falling back to marking it FAILED.`,
                e instanceof Error ? e.stack : String(e),
            );
            await this.markAsFailed(
                generationId,
                platformId,
                'Interrompue par un redémarrage du serveur ; la relance automatique a elle-même échoué. Merci de relancer manuellement.',
            );
        }
    }

    private async markAsFailed(generationId: string, platformId: string, message: string): Promise<void> {
        try {
            await this.generations.markFailed(generationId, message);
        } catch (e: unknown) {
            this.logger.error(
                `Failed to mark orphaned generation ${generationId} as FAILED.`,
                e instanceof Error ? e.stack : String(e),
            );
        }

        try {
            await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
        } catch (e: unknown) {
            this.logger.error(
                `Failed to set platform ${platformId} status to ERROR.`,
                e instanceof Error ? e.stack : String(e),
            );
        }

        this.cancellationRegistry.clear(generationId);
    }

    /**
     * Main task processing routine. Orchestrates the automated project build lifecycle.
     *
     * CONCURRENCY FIX (QUEUE-004 / DB-005): the whole pipeline now runs under a PostgreSQL
     * advisory lock scoped to the PLATFORM. A job BullMQ believed stalled while its first worker
     * was still alive, a second orchestrator instance, or two generations of the same platform can
     * no longer write the same project directory and database at the same time. After acquiring
     * the lock, a generation that already reached a terminal state is skipped.
     */
    async process(job: Job<GenerationJobData>): Promise<void> {
        const { platformId, generationId } = job.data;
        const lockClient = new Client({ connectionString: this.configService.getOrThrow<string>('database.url') });
        await lockClient.connect();
        const lockKey = `generation:${platformId}`;
        try {
            await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);

            const current = await this.prisma.generation.findUnique({
                where: { id: generationId },
                select: { status: true },
            });
            if (!current || current.status === 'SUCCESS' || current.status === 'FAILED') {
                this.logger.warn(
                    `Skipping job ${job.id}: generation ${generationId} is ${current?.status ?? 'missing'}.`,
                );
                return;
            }

            await this.runPipeline(job);
        } finally {
            await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]).catch(() => undefined);
            await lockClient.end().catch(() => undefined);
        }
    }

    private async runPipeline(job: Job<GenerationJobData>): Promise<void> {
        const { platformId, slug, generationId } = job.data;
        const controller = this.cancellationRegistry.register(generationId);

        this.logger.log(`START generation job=${job.id} generationId=${generationId} platformId=${platformId}`);

        const timeoutMs = this.configService.get<number>('GENERATION_COMMAND_TIMEOUT_MS', 300_000);

        const platformBeforeRun = await this.prisma.platform.findUnique({
            where: { id: platformId },
            select: { status: true },
        });

        // GEN-005: an archived (or deleted) platform is never generated - generating it used to flip
        // it back to ACTIVE, routable, and exempt from the archive retention purge.
        if (!platformBeforeRun || platformBeforeRun.status === 'ARCHIVED') {
            await this.generations
                .markFailed(generationId, 'La plateforme est archivée ou supprimée : génération annulée.')
                .catch(() => undefined);
            this.cancellationRegistry.clear(generationId);
            return;
        }

        // ZERO-DOWNTIME REGENERATION: an ACTIVE platform keeps its status (and its running
        // container stays routable) for the whole duration of a regeneration. A first generation
        // flips to GENERATING. Note: `migrate deploy` still runs against the database the running
        // version uses, which is why destructive statements now need explicit approval (GEN-001).
        const hadWorkingVersion = platformBeforeRun.status === 'ACTIVE';

        await this.generations.markRunning(generationId);
        if (!hadWorkingVersion) {
            await this.updatePlatformStatusUnlessArchived(platformId, 'GENERATING');
        } else {
            await this.log(
                generationId,
                'ℹ Regenerating an already-ACTIVE platform - the currently running version stays live and routable through the gateway for the whole duration of this build.',
            );
        }

        try {
            // STEP 1: DATABASE PROVISIONING
            await this.log(generationId, '→ Checking database configuration...');
            let databaseUrl: string;
            const existingDatabase = await this.prisma.platformDatabase.findUnique({ where: { platformId } });

            if (existingDatabase) {
                databaseUrl = await this.provisioning.getDecryptedConnectionUrl(platformId);
                await this.log(generationId, `  Reusing existing database: ${existingDatabase.databaseName}`);
            } else {
                await this.log(generationId, '→ Provisioning new database...');
                const result = await this.provisioning.provisionDatabaseForPlatform(platformId, slug);
                databaseUrl = result.databaseUrl;
                await this.log(generationId, `  Database successfully created: ${result.databaseName}`);
            }

            // STEP 2: PROJECT SCAFFOLDING
            await this.log(generationId, '→ Scaffolding project files...');
            const port = await this.portAllocator.getOrAllocatePort(platformId);
            const triggeredBy = await this.prisma.generation.findUnique({
                where: { id: generationId },
                select: { triggeredById: true },
            });
            const { projectPath, isFirstGeneration } = await this.scaffolder.scaffold({
                platformId,
                slug,
                databaseUrl,
                port,
                triggeredById: triggeredBy?.triggeredById ?? undefined,
            });

            await this.log(generationId, `  Project scaffolded at ${projectPath}`);
            await this.log(
                generationId,
                isFirstGeneration
                    ? '  Initial project generation detected.'
                    : '  Re-generation detected: existing migration history preserved.',
            );

            const shadowDatabaseUrl = await this.provisioning.ensureShadowDatabaseUrl();
            // SEC-001: these are the ONLY variables (besides PATH/HOME/proxy settings, see
            // `buildChildProcessEnv`) the generated project's tooling receives - never the
            // orchestrator's own secrets.
            const envOverrides = { DATABASE_URL: databaseUrl, SHADOW_DATABASE_URL: shadowDatabaseUrl };

            // STEP 3: INSTALL DEPENDENCIES (the previous lockfile is preserved by the scaffolder)
            await this.log(generationId, '→ Installing package dependencies...');
            await this.runStep(
                generationId,
                'pnpm',
                ['install'],
                projectPath,
                timeoutMs,
                envOverrides,
                controller.signal,
            );

            // STEP 4: GENERATE PRISMA CLIENT
            await this.log(generationId, '→ Generating Prisma client...');
            await this.runStep(
                generationId,
                'pnpm',
                ['exec', 'prisma', 'generate'],
                projectPath,
                timeoutMs,
                envOverrides,
                controller.signal,
            );

            // STEP 5: GENERATE A NEW MIGRATION FILE FOR THE CURRENT SCHEMA, IF NEEDED
            await this.log(generationId, '→ Checking for schema changes to migrate...');
            await this.provisioning.withShadowDatabaseLock(() =>
                this.generateMigrationIfNeeded(
                    generationId,
                    projectPath,
                    timeoutMs,
                    envOverrides,
                    controller.signal,
                    job.data.allowDestructiveMigration === true,
                ),
            );

            // STEP 6: DATABASE MIGRATIONS
            await this.log(generationId, '→ Applying Prisma database migrations...');
            await this.runStep(
                generationId,
                'pnpm',
                ['exec', 'prisma', 'migrate', 'deploy'],
                projectPath,
                timeoutMs,
                envOverrides,
                controller.signal,
            );

            // STEP 7: BUILD PROJECT
            await this.log(generationId, '→ Compiling NestJS project...');
            await this.runStep(
                generationId,
                'pnpm',
                ['run', 'build'],
                projectPath,
                timeoutMs,
                envOverrides,
                controller.signal,
            );

            // STEP 8: SUCCESS COMPLETION
            const platform = await this.prisma.platform.findUniqueOrThrow({
                where: { id: platformId },
                select: { schemaVersion: true },
            });

            const nextSchemaVersion = platform.schemaVersion + 1;
            await this.generations.markSuccess(generationId, nextSchemaVersion);
            // GEN-005: conditional update - an archive that happened DURING the build wins.
            const updated = await this.prisma.platform.updateMany({
                where: { id: platformId, status: { not: 'ARCHIVED' } },
                data: { status: 'ACTIVE', schemaVersion: nextSchemaVersion },
            });
            if (updated.count === 0) {
                await this.log(generationId, 'ℹ The platform was archived during this build - it stays archived.');
            }

            await this.log(
                generationId,
                `✅ Generation completed successfully. Updated schema version: ${nextSchemaVersion}.`,
            );

            // RT-001: pre-build the runtime image now, so starting the platform no longer runs a
            // multi-minute `docker build` inside an HTTP request. Best effort: `start()` rebuilds
            // it if this failed (e.g. Docker temporarily unavailable).
            try {
                await this.log(generationId, '→ Building runtime image...');
                await this.dockerRuntime.buildImageForGeneration(platformId, slug, nextSchemaVersion);
                await this.log(generationId, '  Runtime image ready.');
            } catch (imageError: unknown) {
                await this.log(
                    generationId,
                    `⚠ Runtime image not pre-built (it will be built at start): ${imageError instanceof Error ? imageError.message : String(imageError)}`,
                );
            }
        } catch (error: unknown) {
            const isCancelled = error instanceof CommandCancelledError;
            if (isCancelled && this.cancellationRegistry.isShuttingDown()) {
                // Interrupted by a server shutdown, not by the user: the generation stays RUNNING
                // and is restarted by `reconcileOrphanedGenerations()` at the next boot.
                this.logger.warn(`Generation ${generationId} interrupted by shutdown - will resume at next boot.`);
                return;
            }
            const message = redactSecrets(error instanceof Error ? error.message : String(error));
            const failureReason = isCancelled ? 'Cancelled by user.' : message;

            this.logger.error(
                `Generation job ${generationId} failed.`,
                error instanceof Error ? redactSecrets(error.stack ?? '') : undefined,
            );

            try {
                await this.log(
                    generationId,
                    isCancelled ? '⏹ Generation Cancelled.' : `❌ Generation failed: ${message}`,
                );
            } catch (logError: unknown) {
                this.logger.error(
                    `Failed to record failure log for generation ${generationId}.`,
                    logError instanceof Error ? logError.stack : String(logError),
                );
            }

            try {
                await this.generations.markFailed(generationId, failureReason);
            } catch (statusError: unknown) {
                this.logger.error(
                    `Failed to set status to FAILED for generation ${generationId}.`,
                    statusError instanceof Error ? statusError.stack : String(statusError),
                );
            }

            if (!hadWorkingVersion) {
                try {
                    await this.updatePlatformStatusUnlessArchived(platformId, 'ERROR');
                } catch (platformError: unknown) {
                    this.logger.error(
                        `Failed to set status to ERROR for platform ${platformId}.`,
                        platformError instanceof Error ? platformError.stack : String(platformError),
                    );
                }
            } else {
                try {
                    await this.log(
                        generationId,
                        'ℹ The previously working version is still running and unaffected by this failed regeneration - platform left ACTIVE.',
                    );
                } catch {
                    // Purely informational.
                }
            }
        } finally {
            this.cancellationRegistry.clear(generationId);
        }
    }

    /** GEN-005: status writes never override an ARCHIVED platform. */
    private async updatePlatformStatusUnlessArchived(
        platformId: string,
        status: 'GENERATING' | 'ERROR',
    ): Promise<void> {
        await this.prisma.platform.updateMany({
            where: { id: platformId, status: { not: 'ARCHIVED' } },
            data: { status },
        });
    }

    /**
     * Computes a diff between the migration history on disk and the freshly written
     * `schema.prisma` and, if there is a difference, writes it as a new versioned migration.
     *
     * DATA-SAFETY FIX (GEN-001): the SQL is inspected before being written. Destructive
     * statements (DROP TABLE/COLUMN, column type changes, SET NOT NULL...) - typically caused by
     * archiving or deleting an entity/field - make the generation fail with the list of
     * statements, unless the platform owner explicitly approved destructive changes for this
     * generation. Nothing has been applied to the database at that point.
     */
    private async generateMigrationIfNeeded(
        generationId: string,
        projectPath: string,
        timeoutMs: number,
        envOverrides: Record<string, string>,
        signal: AbortSignal | undefined,
        allowDestructiveMigration: boolean,
    ): Promise<void> {
        const migrationsDir = path.join(projectPath, 'prisma', 'migrations');
        await fsp.mkdir(migrationsDir, { recursive: true });

        // `prisma migrate diff --from-migrations` requires migration_lock.toml to know the connector.
        const lockFilePath = path.join(migrationsDir, 'migration_lock.toml');
        if (!fs.existsSync(lockFilePath)) {
            await fsp.writeFile(
                lockFilePath,
                '# Please do not edit this file manually\n' +
                    '# It should be added in your version-control system (e.g., Git)\n' +
                    'provider = "postgresql"\n',
                'utf8',
            );
        }

        const { stdout } = await runCommand(
            'pnpm',
            [
                'exec',
                'prisma',
                'migrate',
                'diff',
                '--from-migrations',
                './prisma/migrations',
                '--to-schema',
                './prisma/schema.prisma',
                '--script',
            ],
            projectPath,
            timeoutMs,
            envOverrides,
            signal,
        );

        const sql = stdout.trim();
        if (!sql) {
            await this.log(generationId, '  No schema changes detected - no new migration needed.');
            return;
        }

        const destructive = findDestructiveStatements(sql);
        if (destructive.length > 0) {
            if (!allowDestructiveMigration) {
                throw new Error(
                    'Destructive schema changes detected - nothing was applied to the database. ' +
                        'These statements would delete or rewrite existing data:\n' +
                        destructive.map((statement) => `  • ${statement}`).join('\n') +
                        '\nRestore the archived/deleted entities or fields, or have the platform owner relaunch the ' +
                        'generation with "allowDestructiveMigration": true after taking a backup.',
                );
            }
            await this.log(
                generationId,
                `⚠ ${destructive.length} destructive statement(s) explicitly approved by the platform owner:`,
            );
            for (const statement of destructive) await this.log(generationId, `  • ${statement}`);
        }

        // Second-level timestamp + a random suffix: two diffs in the same second never collide.
        const migrationName = `${this.formatMigrationTimestamp(new Date())}_platform_update_${Math.random().toString(36).slice(2, 8)}`;
        const migrationFolder = path.join(migrationsDir, migrationName);
        await fsp.mkdir(migrationFolder, { recursive: true });
        await fsp.writeFile(path.join(migrationFolder, 'migration.sql'), `${sql}\n`, 'utf8');

        await this.log(generationId, `  New migration created: ${migrationName}`);
    }

    /**
     * Formats a timestamp using Prisma's own migration folder naming convention
     * (`YYYYMMDDHHmmss`), so migrations created here sort and read identically to ones a
     * developer would create locally with `prisma migrate dev`.
     */
    private formatMigrationTimestamp(date: Date): string {
        return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    }

    /**
     * Safely executes an external shell CLI command (e.g. pnpm) using isolated process execution and streams standard output to logs.
     */
    private async runStep(
        generationId: string,
        command: 'pnpm' | 'npx',
        args: string[],
        cwd: string,
        timeoutMs: number,
        envOverrides: Record<string, string> = {},
        signal?: AbortSignal,
    ): Promise<void> {
        try {
            const { stdout, stderr } = await runCommand(command, args, cwd, timeoutMs, envOverrides, signal);
            if (stdout?.trim()) {
                await this.log(generationId, stdout.trim());
            }
            if (stderr?.trim()) {
                await this.log(generationId, stderr.trim());
            }
        } catch (error: unknown) {
            if (error instanceof CommandFailedError) {
                const output = error.stderr?.trim() || error.stdout?.trim();
                if (output) {
                    try {
                        await this.log(generationId, output);
                    } catch (logError: unknown) {
                        this.logger.error(
                            `Failed to log execution output for failed command in generation ${generationId}.`,
                            logError instanceof Error ? logError.stack : String(logError),
                        );
                    }
                }
            }
            throw error;
        }
    }

    /**
     * Appends a formatted line entry into the database build log history associated with the current generation run.
     */
    private async log(generationId: string, line: string): Promise<void> {
        const normalizedLine = redactSecrets(line.trim());
        if (!normalizedLine) return;
        await this.generations.appendLog(generationId, normalizedLine);
    }
}
