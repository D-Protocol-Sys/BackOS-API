import { Controller, Post, Get, Param, ForbiddenException, NotFoundException, BadRequestException, Query } from '@nestjs/common';
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
        private readonly runtimeManager: RuntimeManagerService,
    ) {}

    /**
     * Triggers a new generation pipeline for a specified platform.
     * Verifies permissions, prevents concurrent generation runs, creates the database record,
     * and enqueues the task in BullMQ.
     *
     * @param actor - The authenticated user triggering the operation.
     * @param platformId - Target platform unique identifier.
     */
    @Post('generate')
    async triggerGeneration(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Platform not found.');

        // Enforce authorization rules before triggering a new build
        await this.assertCanGenerate(actor, platform);

        // Prevent race conditions or overlapping jobs on the same platform
        if (platform.status === 'GENERATING') {
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
            await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
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
     */
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
     */
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