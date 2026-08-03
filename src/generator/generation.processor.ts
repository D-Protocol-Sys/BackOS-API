import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { GENERATION_QUEUE_NAME } from './generator-queue.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from './provisioning.service';
import { ProjectScaffolderService } from './project-scaffolder.service';
import { GenerationsService } from './generations.service';
import { runCommand, CommandFailedError } from '../common/utils/command-runner.util';
import { PortAllocatorService } from './port-allocator.service';

export interface GenerationJobData {
    platformId: string;
    slug: string;
    generationId: string;
}

@Processor(GENERATION_QUEUE_NAME)
export class GenerationProcessor extends WorkerHost {

    private readonly logger = new Logger(GenerationProcessor.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly provisioning: ProvisioningService,
        private readonly scaffolder: ProjectScaffolderService,
        private readonly generations: GenerationsService,
        private readonly portAllocator: PortAllocatorService,
        private readonly configService: ConfigService,
    ) {
        super();
    }

    async process(job: Job<GenerationJobData>): Promise<void> {
        
        const { platformId, slug, generationId } = job.data;
        const timeoutMs = this.configService.get<number>('GENERATION_COMMAND_TIMEOUT_MS', 300_000);

        await this.generations.markRunning(generationId);
        await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'GENERATING' } });

        try {
        
            await this.log(generationId, '→ Provisioning de la base de données...');
            let dbUrl: string;
            const existingDb = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
            if (existingDb) {
                dbUrl = await this.provisioning.getDecryptedConnectionUrl(platformId);
                await this.log(generationId, `  Base existante réutilisée : ${existingDb.databaseName}`);
            } else {
                const result = await this.provisioning.provisionDatabaseForPlatform(platformId, slug);
                dbUrl = result.databaseUrl;
                await this.log(generationId, `  Base créée : ${result.databaseName}`);
            }

            await this.log(generationId, '→ Génération des fichiers du projet...');
            const port = await this.portAllocator.getOrAllocatePort(platformId);
            const { projectPath } = await this.scaffolder.scaffold({
                platformId,
                slug,
                databaseUrl: dbUrl,
                port,
            });
            await this.log(generationId, `  Projet écrit dans ${projectPath} (port ${port})`);

            await this.log(generationId, '→ Installation des dépendances (pnpm install)...');
            await this.runStep(generationId, 'pnpm', ['install'], projectPath, timeoutMs);

            await this.log(generationId, '→ Génération du client Prisma...');
            await this.runStep(generationId, 'npx', ['prisma', 'generate'], projectPath, timeoutMs);

            await this.log(generationId, '→ Application des migrations...');
            await this.runStep(
                generationId,
                'npx',
                ['prisma', 'migrate', 'dev', '--name', 'init', '--skip-generate'],
                projectPath,
                timeoutMs,
            );

            await this.log(generationId, '→ Compilation du projet (pnpm run build)...');
            await this.runStep(generationId, 'pnpm', ['run', 'build'], projectPath, timeoutMs);

            await this.log(generationId, '✅ Génération terminée avec succès.');
            await this.generations.markSuccess(generationId);
            await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ACTIVE' } });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger.error(`Génération ${generationId} échouée`, error instanceof Error ? error.stack : undefined);

            await this.log(generationId, `❌ Échec : ${message}`);
            await this.generations.markFailed(generationId, message);
            await this.prisma.platform.update({ where: { id: platformId }, data: { status: 'ERROR' } });
        }
    }

    private async runStep(
        generationId: string,
        command: 'pnpm' | 'npx',
        args: string[],
        cwd: string,
        timeoutMs: number,
    ) {
        try {
            const { stdout } = await runCommand(command, args, cwd, timeoutMs);
            if (stdout) await this.log(generationId, stdout.trim());
        } catch (error) {
            if (error instanceof CommandFailedError) {
                await this.log(generationId, error.stderr || error.stdout);
            }
            throw error;
        }
    }

    private async log(generationId: string, line: string) {
        await this.generations.appendLog(generationId, line);
    }
}