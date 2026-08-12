import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Service responsible for managing generation task records and their log outputs.
 * Acts as the state management persistence layer for asynchronous build/generation jobs.
 */
@Injectable()
export class GenerationsService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Initializes a new generation record with an initial 'PENDING' status.
     * * @param platformId - The ID of the target platform being generated.
     * @param triggeredById - The ID of the user or system worker triggering the job.
     */
    async create(platformId: string, triggeredById: string) {
        return this.prisma.generation.create({
            data: { platformId, triggeredById, status: 'PENDING' },
        });
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
        const current = await this.prisma.generation.findUniqueOrThrow({
            where: { id: generationId },
            select: { logs: true },
        });
        
        // Append new line and cap total logs length at 50,000 characters (keeping the most recent outputs)
        const updatedLogs = `${current.logs ?? ''}${line}\n`.slice(-50_000);
        
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { logs: updatedLogs },
        });
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
     * Fetches all generation task records associated with a specific platform,
     * sorted chronologically in descending order (most recent first).
     * * @param platformId - Target platform identifier.
     */
    async listForPlatform(platformId: string) {
        return this.prisma.generation.findMany({
            where: { platformId },
            orderBy: { startedAt: 'desc' },
        });
    }
}