import {
    Controller,
    Post,
    Get,
    Param,
    Body,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
    ConflictException,
    ServiceUnavailableException,
    Query,
    UseGuards,
    Res,
    Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GENERATION_QUEUE_NAME, GENERATION_JOB_RETENTION } from './generator-queue.module';
import { GenerateOptionsDto } from './dto/generate-options.dto';
import { AuditLogService } from '../audit/audit-log.service';
import { AUDIT_ACTIONS, AuditAction } from '../common/constants/audit-actions';
import { AUDIT_TARGETS } from '../common/constants/audit-target.constant';
import { GenerationsService } from './generations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import type { GenerationJobData } from './generation.processor';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { GenerationCancellationRegistry } from './generation-cancellation.registry';
import { ApiManifestService, type ApiManifest } from './api-manifest.service';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';
import { PlatformAccessService } from '../platforms/platform-access.service';
import { PLATFORM_PERMISSIONS } from '../common/constants/platform-permissions.constant';

/**
 * Type representing the authenticated user context (actor) triggering or viewing generations.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * REST Controller exposing platform code generation endpoints.
 * Handles access control checks and dispatches background tasks to the BullMQ processing queue.
 */
@ApiTags('Generator')
@ApiBearerAuth('access-token')
@Controller('platforms/:platformId')
export class GeneratorController {
    private readonly logger = new Logger(GeneratorController.name);

    constructor(
        @InjectQueue(GENERATION_QUEUE_NAME) private readonly queue: Queue<GenerationJobData>,
        private readonly generations: GenerationsService,
        private readonly prisma: PrismaService,
        private readonly cancellationRegistry: GenerationCancellationRegistry,
        private readonly runtimeManager: DockerRuntimeManagerService,
        private readonly apiManifest: ApiManifestService,
        private readonly access: PlatformAccessService,
        private readonly auditLog: AuditLogService,
    ) {}

    /** SEC-027: generation and runtime operations are audited (never blocking). */
    private async audit(
        actorId: string,
        action: AuditAction,
        platformId: string,
        metadata: Record<string, unknown> = {},
    ) {
        await this.auditLog
            .log({
                action,
                actorId,
                targetType: AUDIT_TARGETS.PLATFORM,
                targetId: platformId,
                metadata: metadata as never,
            })
            .catch((error) =>
                this.logger.error(
                    `Audit log failed for ${action}.`,
                    error instanceof Error ? error.stack : String(error),
                ),
            );
    }

    /**
     * Triggers a new generation pipeline for a specified platform.
     * Verifies permissions, prevents concurrent generation runs, creates the database record,
     * and enqueues the task in BullMQ.
     *
     * RATE LIMITING: this spawns a real background job (schema build + `npm install` +
     * `prisma migrate` inside a child process - see `generation.processor.ts`), which is
     * expensive in CPU/disk/time. `ThrottlerGuard` is no longer global (see `app.module.ts`),
     * so it is applied here explicitly with a tight, route-specific budget to stop someone
     * from queueing many overlapping generations by mistake or by script.
     *
     * @param actor - The authenticated user triggering the operation.
     * @param platformId - Target platform unique identifier.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    @Post('generate')
    async triggerGeneration(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Body() options: GenerateOptionsDto = {},
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        if (platform.status === 'ARCHIVED') {
            throw new ConflictException('An archived platform cannot be generated. Restore it first.');
        }

        // Enforce authorization rules before triggering a new build
        await this.assertCanGenerate(actor, platform);

        const needsApproval = this.needsOwnerApproval(actor, platform);
        if (options.allowDestructiveMigration && needsApproval) {
            throw new ForbiddenException('Only the platform owner can allow destructive migrations.');
        }

        // CONCURRENCY FIX (DB-005): "no active generation" check and creation now happen in one
        // transaction holding a per-platform advisory lock - two simultaneous clicks (or two
        // instances) can no longer both create a generation.
        const generation = await this.generations.createIfNoneActive(
            platformId,
            actor.userId,
            needsApproval ? 'AWAITING_APPROVAL' : 'PENDING',
        );
        if (!generation) {
            throw new ConflictException(
                'A generation process is already running or awaiting approval for this platform.',
            );
        }

        await this.audit(actor.userId, AUDIT_ACTIONS.GENERATION_REQUESTED, platformId, {
            generationId: generation.id,
            awaitingApproval: needsApproval,
            allowDestructiveMigration: options.allowDestructiveMigration === true,
        });

        if (needsApproval) {
            return {
                message: 'Generation requested. Waiting for the platform owner to approve it.',
                generationId: generation.id,
                status: generation.status,
            };
        }

        await this.enqueue(platform, generation.id, options.allowDestructiveMigration === true);

        return { message: 'Generation started.', generationId: generation.id, status: generation.status };
    }

    /**
     * Owner approval of a generation request filed by an ADMIN (status AWAITING_APPROVAL): the
     * job is moved to PENDING and enqueued exactly as if the owner had triggered it directly.
     * Reserved to the platform owner (or a global GENERATOR_EXECUTE holder).
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 5, ttl: 60_000 } })
    @Post('generations/:generationId/approve')
    async approveGeneration(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('generationId') generationId: string,
        @Body() options: GenerateOptionsDto = {},
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        this.assertOwnerOrGlobalGenerator(actor, platform);

        const generation = await this.generations.getById(generationId);
        if (generation.platformId !== platformId) throw new NotFoundException('Generation not found.');

        // Nothing else may be queued/running (the request itself is excluded from this check).
        if (platform.status === 'ARCHIVED') {
            throw new ConflictException('An archived platform cannot be generated. Restore it first.');
        }
        if (await this.generations.hasActiveGeneration(platformId, generationId)) {
            throw new ConflictException('Another generation is already running for this platform.');
        }

        await this.generations.approve(generationId, actor.userId);
        await this.enqueue(platform, generationId, options.allowDestructiveMigration === true);
        await this.audit(actor.userId, AUDIT_ACTIONS.GENERATION_APPROVED, platformId, {
            generationId,
            allowDestructiveMigration: options.allowDestructiveMigration === true,
        });

        return { message: 'Generation approved and started.', generationId };
    }

    /**
     * Owner rejection of a generation request that is still AWAITING_APPROVAL. Nothing was ever
     * queued, so the platform itself (status, running version) is untouched.
     */
    @Post('generations/:generationId/reject')
    async rejectGeneration(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('generationId') generationId: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        this.assertOwnerOrGlobalGenerator(actor, platform);

        const generation = await this.generations.getById(generationId);
        if (generation.platformId !== platformId) throw new NotFoundException('Generation not found.');

        await this.generations.rejectAwaiting(generationId, 'Rejected by the platform owner.');
        await this.audit(actor.userId, AUDIT_ACTIONS.GENERATION_REJECTED, platformId, { generationId });
        return { message: 'Generation request rejected.' };
    }

    /**
     * Handles explicit cancellation requests for asynchronous generation jobs.
     * Educational Note: Differentiates between `PENDING` jobs (removed directly from the BullMQ queue)
     * and `RUNNING` jobs (signaled via the AbortController cancellation registry).
     */
    @Post('generations/:generationId/cancel')
    async cancelGeneration(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('generationId') generationId: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanGenerate(actor, platform);

        const generation = await this.generations.getById(generationId);
        if (generation.platformId !== platformId) throw new NotFoundException('Generation not found.');

        // Case 0: request still waiting for the owner's approval - never queued, so there is
        // nothing to remove from BullMQ and the platform status must not be touched.
        if (generation.status === 'AWAITING_APPROVAL') {
            await this.generations.rejectAwaiting(generationId, 'Cancelled before approval.');
            return { message: 'Generation request cancelled.' };
        }

        // Case 1: Task is queued but hasn't started execution yet
        if (generation.status === 'PENDING') {
            const job = await this.queue.getJob(generationId);
            if (job) await job.remove();

            await this.generations.markFailed(generationId, 'Cancelled by user before execution.');
            // ZERO-DOWNTIME REGENERATION: only demote the platform to 'ERROR' (un-routable via
            // the gateway - see PlatformGatewayService.resolveTarget()) if it wasn't already
            // ACTIVE. Cancelling a queued REGENERATION of an already-working platform must not
            // cut off the still-running old version, which never has anything to do with this
            // cancelled job in the first place - same reasoning as generation.processor.ts's
            // own failure handling for a running job.
            if (platform.status !== 'ACTIVE') {
                await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
            }
            return { message: 'Generation cancelled.' };
        }

        // Case 2: Task is currently running in an active process
        if (generation.status === 'RUNNING') {
            const controller = this.cancellationRegistry.get(generationId);
            if (!controller) {
                throw new BadRequestException('Cannot cancel: No active task runner found for this generation.');
            }
            controller.abort();
            await this.audit(actor.userId, AUDIT_ACTIONS.GENERATION_CANCELLED, platformId, { generationId });
            return { message: 'Cancellation requested, stopping process...' };
        }

        throw new BadRequestException('This generation is already finished.');
    }

    /**
     * Retrieves the history of all generation attempts for a specific platform.
     *
     * @param actor - The authenticated user requesting the history.
     * @param platformId - Target platform unique identifier.
     */
    @Get('generations')
    async listGenerations(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');

        await this.assertCanReadGenerations(actor, platform);

        return this.generations.listForPlatform(platformId);
    }

    /** Guards `limit`-style query params (RT-001 / API-002). */
    private parseBoundedInt(raw: string | undefined, fallback: number, max: number): number {
        if (raw === undefined) return fallback;
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value) || value < 1) throw new BadRequestException('Invalid numeric parameter.');
        return Math.min(value, max);
    }

    /**
     * Retrieves details and logs for a single generation task execution.
     *
     * @param actor - The authenticated user requesting job details.
     * @param platformId - Target platform unique identifier.
     * @param generationId - Generation record unique identifier.
     */
    @Get('generations/:generationId')
    async getGeneration(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('generationId') generationId: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');

        await this.assertCanReadGenerations(actor, platform);

        // SECURITY FIX (SEC-003): the generation must belong to the platform the caller was
        // authorized on - any generation id used to be returned (cross-tenant logs leak).
        const generation = await this.generations.getById(generationId);
        if (generation.platformId !== platformId) throw new NotFoundException('Generation not found.');
        return generation;
    }

    /**
     * Triggers the start of a platform's isolated runtime container or process.
     *
     * RATE LIMITING: spawns a real OS child process (see `DockerRuntimeManagerService.start()`).
     * Throttled explicitly for the same reason as `POST .../generate` above.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @Post('runtime/start')
    async startRuntime(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanManageRuntime(actor, platform);
        const result = await this.runtimeManager.start(platformId);
        await this.audit(actor.userId, AUDIT_ACTIONS.RUNTIME_STARTED, platformId);
        return result;
    }

    /**
     * Halts an actively running platform runtime instance.
     *
     * RATE LIMITING: same rationale as `runtime/start` above.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @Post('runtime/stop')
    async stopRuntime(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanManageRuntime(actor, platform);
        const result = await this.runtimeManager.stop(platformId);
        await this.audit(actor.userId, AUDIT_ACTIONS.RUNTIME_STOPPED, platformId);
        return result;
    }

    /**
     * Retrieves the operational health and execution state of the target platform runtime.
     */
    @Get('runtime/status')
    async getRuntimeStatus(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanView(actor, platform);
        return this.runtimeManager.getStatus(platformId);
    }

    /**
     * Fetches recent stdout/stderr runtime logs for debugging and system auditing.
     */
    @Get('runtime/logs')
    async getRuntimeLogs(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Query('lines') lines?: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        // SEC-030: runtime logs can contain end users' data - restricted to runtime managers.
        await this.assertCanManageRuntime(actor, platform);
        return this.runtimeManager.getLogs(platformId, this.parseBoundedInt(lines, 200, 2000));
    }

    /**
     * Lists every REST endpoint the generated backend exposes for this platform - one entry
     * per active entity's standard CRUD routes (create/list/get/update/delete) - along with
     * the request body shape each endpoint expects and the response shape it returns.
     *
     * Educational note: this is computed directly from the platform's live entity/field/
     * relation definitions (the same source of truth `CrudGeneratorService` reads from to
     * write the generated controllers), so it stays accurate even for platforms that have not
     * been generated yet, and does not require the generated backend to be running.
     */
    @Get('api-manifest')
    async getApiManifest(@CurrentUser() actor: Actor, @Param('platformId') platformId: string): Promise<ApiManifest> {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanView(actor, platform);
        return this.apiManifest.buildManifest(platform);
    }

    /**
     * Same content as `GET .../api-manifest`, served as a downloadable JSON file so it can be
     * shared with a frontend team, imported into an API client, or archived alongside the
     * project's documentation.
     */
    @Get('api-manifest/export')
    async exportApiManifest(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Res() res: Response,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanView(actor, platform);

        const manifest = await this.apiManifest.buildManifest(platform);

        res.set({
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(platform.slug)}-api-manifest.json"`,
            'X-Content-Type-Options': 'nosniff',
        });
        res.send(JSON.stringify(manifest, null, 2));
    }

    /**
     * Access Control Assertion Helper for runtime start/stop.
     * Allowed for the owner, a global RUNTIME_MANAGE holder, or a platform member whose role
     * (ADMIN or custom) includes the platform-level `runtime.manage` permission.
     */
    private async assertCanManageRuntime(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.RUNTIME_MANAGE)) return;

        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        if (permissions.has(PLATFORM_PERMISSIONS.RUNTIME_MANAGE)) return;

        throw new ForbiddenException("You don't have authorization to manage this platform's runtime.");
    }

    /**
     * Authorization guard checking if the actor may FILE a generation (directly or as a request).
     * Access is granted if:
     * 1. The actor is the owner of the platform.
     * 2. The actor possesses global GENERATOR_EXECUTE permissions.
     * 3. The actor's role on the platform (ADMIN or custom) includes `generator.execute`.
     * Whether the run is immediate or needs the owner's approval is `needsOwnerApproval()`.
     */
    private async assertCanGenerate(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATOR_EXECUTE)) return;

        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        if (permissions.has(PLATFORM_PERMISSIONS.GENERATOR_EXECUTE)) return;

        throw new ForbiddenException('You do not have permission to trigger a generation on this platform.');
    }

    /** Only the owner and global generators (BackOS staff) skip the approval step. */
    private needsOwnerApproval(actor: Actor, platform: { ownerId: string }): boolean {
        if (platform.ownerId === actor.userId) return false;
        if (actor.permissions.includes(PERMISSIONS.GENERATOR_EXECUTE)) return false;
        return true;
    }

    /** Approve/reject are never available to ADMINs or custom roles - owner (or global) only. */
    private assertOwnerOrGlobalGenerator(actor: Actor, platform: { ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATOR_EXECUTE)) return;
        throw new ForbiddenException('Only the platform owner can approve or reject a generation.');
    }

    /** Dispatches the generation job to the Redis queue (job id = generation id). */
    /**
     * RELIABILITY FIX (QUEUE-002): if Redis is unavailable, the generation is marked FAILED
     * instead of staying PENDING forever (which blocked every later generation of the platform).
     */
    private async enqueue(
        platform: { id: string; slug: string },
        generationId: string,
        allowDestructiveMigration = false,
    ) {
        try {
            await this.queue.add(
                'generate',
                {
                    platformId: platform.id,
                    slug: platform.slug,
                    generationId,
                    ...(allowDestructiveMigration ? { allowDestructiveMigration: true } : {}),
                } satisfies GenerationJobData,
                { jobId: generationId, ...GENERATION_JOB_RETENTION },
            );
        } catch (error) {
            this.logger.error(
                `Could not enqueue generation ${generationId}.`,
                error instanceof Error ? error.stack : String(error),
            );
            await this.generations
                .markFailed(generationId, 'Queue unavailable - please retry in a moment.')
                .catch(() => undefined);
            throw new ServiceUnavailableException('The generation queue is temporarily unavailable. Please retry.');
        }
    }

    /**
     * Generation history and logs are reserved to the platform owner and the platform's ADMIN
     * (plus a global GENERATION_READ holder, kept as before) - a plain member, whatever their custom
     * role, cannot read them. Anyone else gets a 404 so the platform's existence isn't leaked.
     */
    private async assertCanReadGenerations(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATION_READ)) return;

        const { isAdmin } = await this.access.getEffectivePermissions(actor, platform);
        if (isAdmin) return;

        throw new NotFoundException('Platform not found.');
    }

    /**
     * Authorization guard checking if the actor has permissions to view runtime details (status, logs, manifest).
     * Access is granted if:
     * 1. The actor is the platform owner.
     * 2. The actor possesses global GENERATION_READ permissions.
     * 3. The actor is a member of the platform.
     */
    private async assertCanView(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATION_READ)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId: platform.id, userId: actor.userId } },
        });
        if (!membership) throw new NotFoundException('Platform not found.');
    }
}
