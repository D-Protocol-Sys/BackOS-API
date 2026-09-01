import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { GenerationsService } from './generations.service';
import { runCommand, CommandFailedError, CommandCancelledError } from '../common/utils/command-runner.util';
import { PortAllocatorService } from './port-allocator.service';
import { GenerationCancellationRegistry } from './generation-cancellation.registry';
import * as fsp from 'fs/promises';
import * as fs from 'fs';
import * as path from 'path';

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
                : await this.prisma.platform.findUnique({ where: { id: generation.platformId }, select: { slug: true } });
            if (!job && !platform) {
                // Platform itself is gone too - nothing sane to restart.
                await this.markAsFailed(generation.id, generation.platformId, 'Interrompue par un redémarrage du serveur : plateforme introuvable, merci de relancer manuellement.');
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

        this.logger.error(
            `Generation ${generationId} failed at the queue level (orphaned/stalled job).`,
            error?.stack,
        );
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
        this.logger.warn(`Auto-restarting generation ${generationId} (attempt ${nextRestartCount}/${maxAutoRestarts}) after an interrupted run.`);

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
                { jobId: generationId },
            );
            // Deliberately left at whatever status it was in (RUNNING) and platform stays
            // GENERATING: from the user's point of view the generation never stopped, it's
            // just picked back up. `process()` will call `markRunning()` again once it does.
        } catch (e: unknown) {
            this.logger.error(`Failed to auto-restart generation ${generationId}; falling back to marking it FAILED.`, e instanceof Error ? e.stack : String(e));
            await this.markAsFailed(generationId, platformId, 'Interrompue par un redémarrage du serveur ; la relance automatique a elle-même échoué. Merci de relancer manuellement.');
        }
    }

    private async markAsFailed(generationId: string, platformId: string, message: string): Promise<void> {
        try { await this.generations.markFailed(generationId, message); }
        catch (e: unknown) { this.logger.error(`Failed to mark orphaned generation ${generationId} as FAILED.`, e instanceof Error ? e.stack : String(e)); }

        try { await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } }); }
        catch (e: unknown) { this.logger.error(`Failed to set platform ${platformId} status to ERROR.`, e instanceof Error ? e.stack : String(e)); }

        this.cancellationRegistry.clear(generationId);
    }

    /**
     * Main task processing routine. Orchestrates the 7-step automated project build lifecycle.
     */
    async process(job: Job<GenerationJobData>): Promise<void> {
        const { platformId, slug, generationId } = job.data;
        const controller = this.cancellationRegistry.register(generationId);

        this.logger.log(
            `START generation job=${job.id} generationId=${generationId} platformId=${platformId}`,
        );
        
        // Fetch command execution timeout threshold (defaults to 5 minutes / 300,000ms)
        const timeoutMs = this.configService.get<number>('GENERATION_COMMAND_TIMEOUT_MS', 300_000);

        // ZERO-DOWNTIME REGENERATION: previously, `platform.status` was unconditionally flipped
        // to 'GENERATING' right here, before anything risky (pnpm install, build, migrate) had
        // even run - and PlatformGatewayService.resolveTarget() refuses to route to anything
        // that isn't 'ACTIVE'. The result: triggering a regeneration made the gateway stop
        // serving the CURRENT, perfectly healthy, still-running container within its 5s cache
        // window - a guaranteed outage for the entire duration of the build, success or
        // failure, even though nothing about the old container/process itself had changed yet.
        //
        // A platform whose status is already 'ACTIVE' when a NEW generation starts means there
        // is a previously-successful version potentially still running right now - see
        // DockerRuntimeManagerService/RuntimeManagerService, which are never stopped or
        // restarted by this pipeline. For that case specifically, `platform.status` is
        // deliberately left untouched (still 'ACTIVE') for the whole duration of this run: the
        // gateway keeps routing to the OLD version the entire time this NEW one is being built,
        // and only a genuine problem with the OLD container itself (crash, the operator
        // stopping it) would ever make it stop serving - never merely "a regeneration is in
        // progress" or "this regeneration failed". A first-time generation (no working version
        // to protect) still flips to 'GENERATING' as before, since there is nothing to leave
        // routable either way.
        //
        // NOTE: this does NOT eliminate every risk of a regeneration affecting the live
        // version - STEP 6 below (`prisma migrate deploy`) still runs against the SAME database
        // the old version is actively using, so a schema change that isn't backward-compatible
        // can still break the old version's queries even though nothing "stopped" it. Worth
        // keeping in mind when writing migrations for a platform you intend to keep serving
        // traffic through a regeneration.
        const platformBeforeRun = await this.prisma.platform.findUniqueOrThrow({
            where: { id: platformId },
            select: { status: true },
        });
        const hadWorkingVersion = platformBeforeRun.status === 'ACTIVE';

        // Update the generation task and (conditionally) platform record status to notify the
        // system that processing has started.
        await this.generations.markRunning(generationId);
        if (!hadWorkingVersion) {
            await this.prisma.platform.update({
                where: { id: platformId },
                data: { status: 'GENERATING' },
            });
        } else {
            await this.log(
                generationId,
                'ℹ Regenerating an already-ACTIVE platform - the currently running version stays live and routable through the gateway for the whole duration of this build.',
            );
        }

        try {
            // STEP 1: DATABASE PROVISIONING
            // Checks whether a database already exists for this platform or provisions a new isolated PostgreSql database.
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
            // Allocates a dedicated port and writes out source files, module definitions, and static configurations to disk.
            await this.log(generationId, '→ Scaffolding project files...');
            const port = await this.portAllocator.getOrAllocatePort(platformId);
            const { projectPath, isFirstGeneration } = await this.scaffolder.scaffold({ platformId, slug, databaseUrl, port });

            await this.log(generationId, `  Project scaffolded at ${projectPath}`);
            await this.log(generationId, isFirstGeneration ? '  Initial project generation detected.' : '  Re-generation detected: existing migration history preserved.');
            
            const shadowDatabaseUrl = await this.provisioning.ensureShadowDatabaseUrl();
            const envOverrides = { DATABASE_URL: databaseUrl, SHADOW_DATABASE_URL: shadowDatabaseUrl };

            // STEP 3: INSTALL DEPENDENCIES
            // Runs `pnpm install`. NOTE: intentionally NOT --frozen-lockfile - scaffold() wipes
            // and recreates the project directory (including any previous pnpm-lock.yaml) on
            // every generation, so there is never a pre-existing lockfile to freeze against;
            // passing that flag here would make every single generation fail on a fresh project.
            await this.log(generationId, '→ Installing package dependencies...');
            await this.runStep(generationId, 'pnpm', ['install'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 4: GENERATE PRISMA CLIENT
            // Executes `prisma generate` to construct type-safe TypeScript database client types from the schema.prisma.
            await this.log(generationId, '→ Generating Prisma client...');
            await this.runStep(generationId, 'pnpm', ['exec', 'prisma', 'generate'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 5: GENERATE A NEW MIGRATION FILE FOR THE CURRENT SCHEMA, IF NEEDED
            // BUGFIX: nothing in this pipeline used to ever CREATE a migration file - only
            // `migrate deploy` (STEP 6) ran, which only APPLIES migrations that already exist
            // on disk. Every regeneration silently left the real Postgres schema stuck at
            // whatever the very first generation created, while `schema.prisma` (and the
            // generated CRUD code built against it) kept moving forward - a guaranteed schema
            // drift the moment anyone edits an entity/field after the first generation.
            // `migrate diff` needs a shadow database to replay the migration history into (see
            // `ProvisioningService.ensureShadowDatabaseUrl()`) - deliberately a single, shared,
            // dedicated database rather than granting CREATEDB to the per-platform DB role,
            // which would let `migrate dev` work directly but would also hand every generated
            // backend's own runtime credentials the ability to create arbitrary databases.
            await this.log(generationId, '→ Checking for schema changes to migrate...');
            await this.generateMigrationIfNeeded(generationId, projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 6: DATABASE MIGRATIONS
            // Applies database structural changes using `prisma migrate deploy`. This non-interactive command applies pending SQL migrations safely.
            await this.log(generationId, '→ Applying Prisma database migrations...');
            await this.runStep(generationId, 'pnpm', ['exec', 'prisma', 'migrate', 'deploy'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 7: BUILD PROJECT
            // Compiles TypeScript source files into executable production JavaScript binaries inside the /dist folder.
            await this.log(generationId, '→ Compiling NestJS project...');
            await this.runStep(generationId, 'pnpm', ['run', 'build'], projectPath, timeoutMs, envOverrides, controller.signal);

            // STEP 8: SUCCESS COMPLETION
            // Updates schema versioning and transitions both the generation task and platform record status to active.
            const platform = await this.prisma.platform.findUniqueOrThrow({
                where: { id: platformId },
                select: { schemaVersion: true },
            });

            const nextSchemaVersion = platform.schemaVersion + 1;
            await this.generations.markSuccess(generationId, nextSchemaVersion);
            await this.prisma.platform.update({
                where: { id: platformId },
                data: { status: 'ACTIVE', schemaVersion: nextSchemaVersion },
            });

            await this.log(generationId, `✅ Generation completed successfully. Updated schema version: ${nextSchemaVersion}.`);
        } catch (error: unknown) {
            const isCancelled = error instanceof CommandCancelledError;
            const message = error instanceof Error ? error.message : String(error);
            const failureReason = isCancelled ? 'Cancelled by user.' : message;

            this.logger.error(`Generation job ${generationId} failed.`, error instanceof Error ? error.stack : undefined);

            // Each step below is independently try/caught (a failure recording the failure
            // should never prevent the others from at least being attempted) - this also folds
            // in what used to be two separate, duplicated attempts at the same three updates
            // (an if/else block immediately followed by an unconditional "Failure Recovery"
            // block doing the exact same three calls again) into one.
            try {
                await this.log(generationId, isCancelled ? '⏹ Generation Cancelled.' : `❌ Generation failed: ${message}`);
            } catch (logError: unknown) {
                this.logger.error(`Failed to record failure log for generation ${generationId}.`, logError instanceof Error ? logError.stack : String(logError));
            }

            try {
                await this.generations.markFailed(generationId, failureReason);
            } catch (statusError: unknown) {
                this.logger.error(`Failed to set status to FAILED for generation ${generationId}.`, statusError instanceof Error ? statusError.stack : String(statusError));
            }

            // ZERO-DOWNTIME REGENERATION (continued from the top of this method): only demote
            // the PLATFORM to 'ERROR' - which the gateway treats as un-routable - when there was
            // no previously-working version to protect in the first place. When
            // `hadWorkingVersion` is true, `platform.status` was deliberately left untouched
            // (still 'ACTIVE') at the start of this run, so there is nothing to revert here: the
            // old, still-running container/process keeps serving traffic exactly as before,
            // completely unaffected by this failed regeneration attempt, until someone fixes
            // the underlying problem and retries. The failed attempt itself is still fully
            // recorded above (`Generation.status = 'FAILED'`, with `errorMsg`/logs) - only the
            // platform's own routability is protected.
            if (!hadWorkingVersion) {
                try {
                    await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
                } catch (platformError: unknown) {
                    this.logger.error(`Failed to set status to ERROR for platform ${platformId}.`, platformError instanceof Error ? platformError.stack : String(platformError));
                }
            } else {
                try {
                    await this.log(generationId, 'ℹ The previously working version is still running and unaffected by this failed regeneration - platform left ACTIVE.');
                } catch {
                    // Purely informational - already logged the failure itself above.
                }
            }
        } finally {
            this.cancellationRegistry.clear(generationId);
        }
    }

    /**
     * Computes a diff between the migration history already on disk (`prisma/migrations/`) and
     * the `schema.prisma` just written by `ProjectScaffolderService`, and - if there is any
     * actual difference - writes it as a brand new, properly versioned migration folder
     * (Prisma's own `<timestamp>_<name>/migration.sql` convention), so `prisma migrate deploy`
     * (the very next step) has something real to apply.
     *
     * NEEDS A SHADOW DATABASE: `migrate diff --from-migrations` can't determine what a
     * migration history results in by statically parsing SQL - it replays it against a real,
     * empty database to find out, then diffs that against the target schema. This was initially
     * (incorrectly) assumed to be a fully offline operation; it isn't. See
     * `ProvisioningService.ensureShadowDatabaseUrl()` for the dedicated, persistent database
     * used for this and why it deliberately isn't the per-platform role's own database (that
     * role has no CREATEDB privilege on purpose).
     */
    private async generateMigrationIfNeeded(
        generationId: string,
        projectPath: string,
        timeoutMs: number,
        envOverrides: Record<string, string>,
        signal?: AbortSignal,
    ): Promise<void> {
        const migrationsDir = path.join(projectPath, 'prisma', 'migrations');
        await fsp.mkdir(migrationsDir, { recursive: true });

        // BUGFIX: `prisma migrate diff --from-migrations <dir>` refuses to run at all unless
        // `<dir>/migration_lock.toml` already exists - that's how it knows which database
        // connector (postgresql, mysql, ...) the migration history on disk was written for,
        // without needing to read/parse the SQL itself. Normally `prisma migrate dev` creates
        // this file automatically the very first time it's run in a project - but this pipeline
        // never calls `migrate dev` (see the class-level comment on `generateMigrationIfNeeded`
        // for why: the per-platform DB role has no CREATEDB privilege, which `migrate dev`
        // requires for its shadow database), so the file never gets created and every single
        // generation failed with "Could not determine the connector from the migrations
        // directory (missing migration_lock.toml)". Written unconditionally, idempotently
        // (the content never changes - this project's connector is always postgresql, see
        // `schema-builder.service.ts`'s hardcoded `provider = "postgresql"` datasource block),
        // and BEFORE the diff below, which is the first command that needs it to exist.
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
                'exec', 'prisma', 'migrate', 'diff',
                '--from-migrations', './prisma/migrations',
                '--to-schema', './prisma/schema.prisma',
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

        const migrationName = `${this.formatMigrationTimestamp(new Date())}_platform_update`;
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
            if (stdout?.trim()) { await this.log(generationId, stdout.trim()); }
            if (stderr?.trim()) { await this.log(generationId, stderr.trim()); }
        } catch (error: unknown) {
            if (error instanceof CommandFailedError) {
                const output = error.stderr?.trim() || error.stdout?.trim();
                if (output) {
                    try { await this.log(generationId, output); } 
                    catch (logError: unknown) { this.logger.error(`Failed to log execution output for failed command in generation ${generationId}.`, logError instanceof Error ? logError.stack : String(logError)); }
                }
            }
            throw error;
        }
    }

    /**
     * Appends a formatted line entry into the database build log history associated with the current generation run.
     */
    private async log(generationId: string, line: string): Promise<void> {
        const normalizedLine = line.trim();
        if (!normalizedLine) return;
        await this.generations.appendLog(generationId, normalizedLine);
    }
}