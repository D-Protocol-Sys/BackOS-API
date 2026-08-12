import { Controller, Post, Get, Param, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { GenerationsService } from './generations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import type { GenerationJobData } from './generation.processor';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';

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
        });

        return { message: 'Generation started.', generationId: generation.id };
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