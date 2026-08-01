import { Controller, Post, Get, Param, ForbiddenException, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { GenerationsService } from './generations.service';
import { PrismaService } from '../prisma/prisma.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import type { GenerationJobData } from './generation.processor';

type Actor = { userId: string; permissions: string[] };

@Controller('platforms/:platformId')
export class GeneratorController {

    constructor(
        @InjectQueue(GENERATION_QUEUE_NAME) private readonly queue: Queue<GenerationJobData>,
        private readonly generations: GenerationsService,
        private readonly prisma: PrismaService,
    ) {}

    @Post('generate')
    async triggerGeneration(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');

        await this.assertCanGenerate(actor, platform);

        if (platform.status === 'GENERATING') {
            throw new ForbiddenException('Une génération est déjà en cours pour cette plateforme.');
        }

        const generation = await this.generations.create(platformId, actor.userId);
        await this.queue.add('generate', {
            platformId,
            slug: platform.slug,
            generationId: generation.id,
        });

        return { message: 'Génération lancée.', generationId: generation.id };
    }

    @Get('generations')
    async listGenerations(@CurrentUser() actor: Actor, @Param('platformId') platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        await this.assertCanView(actor, platform);

        return this.generations.listForPlatform(platformId);
    }

    @Get('generations/:generationId')
    async getGeneration(
        @CurrentUser() actor: Actor,
        @Param('platformId') platformId: string,
        @Param('generationId') generationId: string,
    ) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new NotFoundException('Plateforme introuvable.');
        await this.assertCanView(actor, platform);

        return this.generations.getById(generationId);
    }

    private async assertCanGenerate(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATOR_EXECUTE)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId: platform.id, userId: actor.userId } },
        });
        if (membership?.role === 'ADMIN') return;

        throw new ForbiddenException('Tu ne peux pas déclencher de génération sur cette plateforme.');
    }

    private async assertCanView(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.GENERATION_READ)) return;

        const membership = await this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId: platform.id, userId: actor.userId } },
        });
        if (!membership) throw new NotFoundException('Plateforme introuvable.');
    }
}