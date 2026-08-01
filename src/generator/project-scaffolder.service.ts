import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SchemaBuilderService } from './schema-builder.service';
import {
    packageJsonTemplate,
    NEST_CLI_JSON,
    TSCONFIG_JSON,
    prismaConfigTemplate,
    prismaServiceTemplate,
    prismaModuleTemplate,
    mainTsTemplate,
    appModuleTemplate,
    envTemplate,
} from './templates/generated-project.templates';
import { CrudGeneratorService } from './crud-generator.service';

const SAFE_SLUG_PATTERN = /^[a-z0-9-]+$/;

@Injectable()
export class ProjectScaffolderService {

    private readonly logger = new Logger(ProjectScaffolderService.name);

    constructor(
        private readonly schemaBuilder: SchemaBuilderService,
        private readonly crudGenerator: CrudGeneratorService,
        private readonly configService: ConfigService,
    ) {}

    async scaffold(params: {
        platformId: string;
        slug: string;
        databaseUrl: string;
        port: number;
    }): Promise<{ projectPath: string }> {

        if (!SAFE_SLUG_PATTERN.test(params.slug)) {
            throw new BadRequestException(`Slug de plateforme invalide : "${params.slug}"`);
        }

        const projectPath = this.resolveProjectPath(params.slug);

        await fs.rm(projectPath, { recursive: true, force: true });
        await fs.mkdir(path.join(projectPath, 'src', 'prisma'), { recursive: true });
        await fs.mkdir(path.join(projectPath, 'prisma'), { recursive: true });

        const schemaContent = await this.schemaBuilder.buildSchema(params.platformId);

        await Promise.all([
            fs.writeFile(path.join(projectPath, 'package.json'), packageJsonTemplate(params.slug)),
            fs.writeFile(path.join(projectPath, 'nest-cli.json'), NEST_CLI_JSON),
            fs.writeFile(path.join(projectPath, 'tsconfig.json'), TSCONFIG_JSON),
            fs.writeFile(path.join(projectPath, 'prisma.config.ts'), prismaConfigTemplate()),
            fs.writeFile(path.join(projectPath, '.env'), envTemplate(params.databaseUrl, params.port)),
            fs.writeFile(path.join(projectPath, 'prisma', 'schema.prisma'), schemaContent),
            fs.writeFile(path.join(projectPath, 'src', 'main.ts'), mainTsTemplate()),
            fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.service.ts'), prismaServiceTemplate()),
            fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.module.ts'), prismaModuleTemplate()),
        ]);

        const entities = await this.schemaBuilder.getActiveEntitiesWithFields(params.platformId);

        await this.crudGenerator.generateModulesForEntities(projectPath, entities);

        await fs.writeFile(
            path.join(projectPath, 'src', 'app.module.ts'),
            appModuleTemplate(entities),
        );

        this.logger.log(`Squelette de projet écrit dans ${projectPath}`);

        return { projectPath };

    }

    private resolveProjectPath(slug: string): string {
        const root = this.configService.get<string>('GENERATED_PROJECTS_ROOT', 'generated');
        const absoluteRoot = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
        return path.join(absoluteRoot, slug, 'backend');
    }
}