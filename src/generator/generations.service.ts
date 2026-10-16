import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Service responsible for managing generation task records and their log outputs.
 * Acts as the state management persistence layer for asynchronous build/generation jobs.
 */
@Injectable()
export class GenerationsService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Initializes a new generation record. 'PENDING' (queued right away) by default, or
     * 'AWAITING_APPROVAL' when a non-owner ADMIN triggered it and the owner must approve it
     * first - in that case the caller must NOT enqueue the job yet (see
     * `GeneratorController.triggerGeneration()` / `approveGeneration()`).
     * * @param platformId - The ID of the target platform being generated.
     * @param triggeredById - The ID of the user or system worker triggering the job.
     * @param status - Initial status ('PENDING' or 'AWAITING_APPROVAL').
     */
    async create(platformId: string, triggeredById: string, status: 'PENDING' | 'AWAITING_APPROVAL' = 'PENDING') {
        return this.prisma.generation.create({
            data: { platformId, triggeredById, status },
        });
    }

    /**
     * Owner approval of a generation waiting in 'AWAITING_APPROVAL': moves it to 'PENDING' and
     * records who approved it and when. The caller is responsible for enqueueing the job right
     * after. Throws if the generation isn't awaiting approval (already approved, rejected,
     * cancelled...), so a double-click or a stale UI can never enqueue the same job twice.
     */
    /**
     * CONCURRENCY FIX (DB-005): creates a generation only if none is PENDING / RUNNING /
     * AWAITING_APPROVAL for the platform. The check and the insert run in one transaction under a
     * per-platform advisory lock, so concurrent requests cannot both pass the check.
     * Returns null when another generation is already active.
     */
    async createIfNoneActive(
        platformId: string,
        triggeredById: string,
        status: 'PENDING' | 'AWAITING_APPROVAL' = 'PENDING',
    ) {
        return this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`generation-create:${platformId}`}))`;
            const inFlight = await tx.generation.findFirst({
                where: { platformId, status: { in: ['AWAITING_APPROVAL', 'PENDING', 'RUNNING'] } },
                select: { id: true },
            });
            if (inFlight) return null;
            return tx.generation.create({ data: { platformId, triggeredById, status } });
        });
    }

    async approve(generationId: string, approverId: string) {
        const result = await this.prisma.generation.updateMany({
            where: { id: generationId, status: 'AWAITING_APPROVAL' },
            data: { status: 'PENDING', approvedById: approverId, approvedAt: new Date() },
        });
        if (result.count === 0) {
            throw new BadRequestException('This generation is not awaiting approval.');
        }
        return this.getById(generationId);
    }

    /**
     * Owner rejection (or requester cancellation) of a generation still waiting for approval.
     * Only valid from 'AWAITING_APPROVAL'; the generation ends as FAILED with the given message.
     */
    async rejectAwaiting(generationId: string, errorMsg: string) {
        const result = await this.prisma.generation.updateMany({
            where: { id: generationId, status: 'AWAITING_APPROVAL' },
            data: { status: 'FAILED', errorMsg, finishedAt: new Date() },
        });
        if (result.count === 0) {
            throw new BadRequestException('This generation is not awaiting approval.');
        }
    }

    /**
     * Updates the status of a generation job to 'RUNNING' when processing begins.
     * * @param generationId - The unique identifier of the generation record.
     */
    async markRunning(generationId: string) {
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { status: 'RUNNING' },
        });
    }

    /**
     * Appends a log entry line to the generation's persistent log history.
     * Uses slicing (`.slice(-50_000)`) to maintain a strict size limit and prevent database bloat.
     * * @param generationId - The target generation record ID.
     * @param line - The log message string to append.
     */
    async appendLog(generationId: string, line: string) {
        // PERF / CONCURRENCY FIX (DB-007): one atomic UPDATE instead of read-modify-write of the
        // whole log (quadratic I/O and lost lines when two writers interleave). Last 50k chars kept.
        const updated = await this.prisma.$executeRaw`
            UPDATE generations
            SET logs = right(coalesce(logs, '') || ${line} || E'\n', 50000)
            WHERE id = ${generationId}`;
        if (updated === 0) throw new NotFoundException('Generation not found.');
    }

    /**
     * Marks the generation state as successfully completed, records completion timestamp,
     * and sets the new schema version achieved.
     * * @param generationId - The target generation record ID.
     * @param schemaVersion - Incremented schema version identifier.
     */
    async markSuccess(generationId: string, schemaVersion: number) {
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { status: 'SUCCESS', finishedAt: new Date(), schemaVersion },
        });
    }

    /**
     * Marks the generation process as failed, stores the exception error message,
     * and sets the completion timestamp.
     * * @param generationId - The target generation record ID.
     * @param errorMsg - Description or stack detail of the error encountered.
     */
    async markFailed(generationId: string, errorMsg: string) {
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { status: 'FAILED', errorMsg, finishedAt: new Date() },
        });
    }

    /**
     * Retrieves a single generation record by its primary key.
     * Throws an HTTP 404 (NotFoundException) if the generation ID does not exist.
     * * @param id - Generation primary key.
     */
    async getById(id: string) {
        const generation = await this.prisma.generation.findUnique({ where: { id } });
        if (!generation) throw new NotFoundException('Generation not found.');
        return generation;
    }

    /**
     * Whether a generation is currently in flight for this platform (queued or actively
     * running). Used as the concurrency guard in `GeneratorController.triggerGeneration()`/
     * `cancelGeneration()` INSTEAD of `platform.status === 'GENERATING'` - as of the
     * zero-downtime regeneration change in `generation.processor.ts`, a regeneration of an
     * already-ACTIVE platform deliberately leaves `platform.status` untouched (still 'ACTIVE',
     * so the gateway keeps routing to the old, still-running version), so that field can no
     * longer be used to detect "is something already generating for this platform" - this
     * queries the actual source of truth (the Generation records themselves) instead.
     */
    async hasActiveGeneration(platformId: string, excludeGenerationId?: string): Promise<boolean> {
        const inFlight = await this.prisma.generation.findFirst({
            where: {
                platformId,
                // AWAITING_APPROVAL counts too: only one generation request may exist at a time
                // per platform, so a second ADMIN can't pile up requests behind the first.
                status: { in: ['AWAITING_APPROVAL', 'PENDING', 'RUNNING'] },
                ...(excludeGenerationId ? { id: { not: excludeGenerationId } } : {}),
            },
            select: { id: true },
        });
        return !!inFlight;
    }

    /**
     * Fetches all generation task records associated with a specific platform,
     * sorted chronologically in descending order (most recent first).
     * * @param platformId - Target platform identifier.
     */
    async listForPlatform(platformId: string) {
        // DB-006 / PERF-004: bounded list (the 100 most recent generations) WITHOUT the logs
        // column (up to 50 kB each) - the full logs are served by GET .../generations/:id.
        return this.prisma.generation.findMany({
            where: { platformId },
            orderBy: { startedAt: 'desc' },
            take: 100,
            select: {
                id: true,
                status: true,
                errorMsg: true,
                schemaVersion: true,
                platformId: true,
                triggeredById: true,
                approvedById: true,
                approvedAt: true,
                startedAt: true,
                finishedAt: true,
            },
        });
    }
}
