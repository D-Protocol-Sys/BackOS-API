import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class GenerationsService {

    constructor(private readonly prisma: PrismaService) {}

    async create(platformId: string, triggeredById: string) {
        return this.prisma.generation.create({
            data: { platformId, triggeredById, status: 'PENDING' },
        });
    }

    async markRunning(generationId: string) {
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { status: 'RUNNING' },
        });
    }

    async appendLog(generationId: string, line: string) {
        const current = await this.prisma.generation.findUniqueOrThrow({
            where: { id: generationId },
            select: { logs: true },
        });
        const updatedLogs = `${current.logs ?? ''}${line}\n`.slice(-50_000);
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { logs: updatedLogs },
        });
    }

    async markSuccess(generationId: string) {
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { status: 'SUCCESS', finishedAt: new Date() },
        });
    }

    async markFailed(generationId: string, errorMsg: string) {
        return this.prisma.generation.update({
            where: { id: generationId },
            data: { status: 'FAILED', errorMsg, finishedAt: new Date() },
        });
    }

    async getById(id: string) {
        const generation = await this.prisma.generation.findUnique({ where: { id } });
        if (!generation) throw new NotFoundException('Génération introuvable.');
        return generation;
    }

    async listForPlatform(platformId: string) {
        return this.prisma.generation.findMany({
            where: { platformId },
            orderBy: { startedAt: 'desc' },
        });
    }
}