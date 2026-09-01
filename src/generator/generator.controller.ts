import { Controller, Post, Get, Param, ForbiddenException, NotFoundException, BadRequestException, Query, UseGuards, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { GenerationsService } from './generations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import type { GenerationJobData } from './generation.processor';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { GenerationCancellationRegistry } from './generation-cancellation.registry';
import { RuntimeManagerService } from './runtime-manager.service';
import { ApiManifestService, type ApiManifest, } from './api-manifest.service';
import { DockerRuntimeManagerService } from './docker-runtime-manager.service';

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
    constructor(
        @InjectQueue(GENERATION_QUEUE_NAME) private readonly queue: Queue<GenerationJobData>,
        private readonly generations: GenerationsService,
        private readonly prisma: PrismaService,
        private readonly cancellationRegistry: GenerationCancellationRegistry,
        private readonly runtimeManager: DockerRuntimeManagerService,
        private readonly apiManifest: ApiManifestService,
    ) {}

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
    async triggerGeneration(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');

        // Enforce authorization rules before triggering a new build
        await this.assertCanGenerate(actor, platform);

        // Prevent race conditions or overlapping jobs on the same platform. Deliberately NOT
        // `platform.status === 'GENERATING'` anymore - see GenerationsService.hasActiveGeneration()'s
        // doc comment for why that field can no longer be trusted for this check.
        if (await this.generations.hasActiveGeneration(platformId)) {
            throw new ForbiddenException('A generation process is already running for this platform.');
        }

        // Create the tracking entity and dispatch the background job to the Redis queue
        const generation = await this.generations.create(platformId, actor.userId);
        await this.queue.add('generate', {
            platformId,
            slug: platform.slug,
            generationId: generation.id,
        }, { jobId: generation.id });

        return { message: 'Generation started.', generationId: generation.id };
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
        
        await this.assertCanView(actor, platform);

        return this.generations.listForPlatform(platformId);
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
        
        await this.assertCanView(actor, platform);

        return this.generations.getById(generationId);
    }
    
    /**
     * Triggers the start of a platform's isolated runtime container or process.
     *
     * RATE LIMITING: spawns a real OS child process (see `RuntimeManagerService.start()`).
     * Throttled explicitly for the same reason as `POST .../generate` above.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @Post('runtime/start')
    async startRuntime(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanManageRuntime(actor, platform);
        return this.runtimeManager.start(platformId);
    }
    
    /**
     * Halts an actively running platform runtime instance.
     *
     * RATE LIMITING: same rationale as `runtime/start` above.
     */
    @UseGuards(ThrottlerGuard)
    @Throttle({ default: { limit: 10, ttl: 60_000 } })
    @Post('runtime/stop')
    async stopRuntime(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');
        await this.assertCanManageRuntime(actor, platform);
        return this.runtimeManager.stop(platformId);
    }
    
    /**
     * Retrieves the operational health and execution state of the target platform runtime.
     */
    @Get('runtime/status')
    async getRuntimeStatus(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
    ) {
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
        await this.assertCanView(actor, platform);
        return this.runtimeManager.getLogs(platformId, lines ? Number(lines) : undefined);
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
     * Access Control Assertion Helper.
     * Educational Note: Implements multi-tiered authorization evaluation checking:
     * 1. Resource Ownership (Direct Owner)
     * 2. System-wide Role/Permission Override (Global PERMISSIONS.RUNTIME_MANAGE)
     * 3. Contextual Organization/Platform Membership Role (ADMIN role)
     */
    private async assertCanManageRuntime(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.RUNTIME_MANAGE)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId: platform.id, userId: actor.userId } },
        });
        if (membership?.role === 'ADMIN') return;

        throw new ForbiddenException("You don't have authorization to manage this platform's runtime.");
    }

    /**
     * Authorization guard checking if the actor has permissions to trigger a generation job.
     * Access is granted if:
     * 1. The actor is the owner of the platform.
     * 2. The actor possesses global GENERATOR_EXECUTE permissions.
     * 3. The actor holds an ADMIN role on the specific platform membership.
     */
    private async assertCanGenerate(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATOR_EXECUTE)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId: platform.id, userId: actor.userId } },
        });
        if (membership?.role === 'ADMIN') return;

        throw new ForbiddenException('You do not have permission to trigger a generation on this platform.');
    }

    /**
     * Authorization guard checking if the actor has permissions to view generation details and logs.
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