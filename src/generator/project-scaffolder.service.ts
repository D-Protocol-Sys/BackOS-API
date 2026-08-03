import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs/promises';
import * as path from 'path';
import { SchemaBuilderService } from './schema-builder.service';
import { CrudGeneratorService } from './crud-generator.service';
import { PlatformServicesService } from './platform-services.service';
import { ServiceCatalog } from './service-catalog/service-catalog';
import { SERVICE_FILE_GENERATORS } from './service-catalog/service-file-generators';
import { PrismaService } from '../prisma/prisma.service';
import {
    packageJsonObject,
    NEST_CLI_JSON,
    TSCONFIG_JSON,
    prismaConfigTemplate,
    prismaServiceTemplate,
    prismaModuleTemplate,
    mainTsTemplate,
    appModuleTemplate,
    envTemplate,
} from './templates/generated-project.templates';
import { computeRelationFieldsByEntity } from '../common/utils/relation-metadata.util';

const SAFE_SLUG_PATTERN = /^[a-z0-9-]+$/;

@Injectable()
export class ProjectScaffolderService {

    private readonly logger = new Logger(ProjectScaffolderService.name);

    constructor(
        private readonly schemaBuilder: SchemaBuilderService,
        private readonly crudGenerator: CrudGeneratorService,
        private readonly platformServices: PlatformServicesService,
        private readonly serviceCatalog: ServiceCatalog,
        private readonly prisma: PrismaService,
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

        const activeServices = await this.prisma.platformService.findMany({ where: { platformId: params.platformId } });

        const prismaBlocks: string[] = [];
        const extraPnpmDeps: Record<string, string> = {};
        const extraEnvVars: Record<string, unknown> = {};
        const extraModules: { name: string; importPath: string }[] = [];

        if (activeServices.some((s) => s.serviceKey === 'scheduler')) {
            extraEnvVars.redisHost = this.configService.get<string>('REDIS_HOST', 'localhost');
            extraEnvVars.redisPort = this.configService.get<number>('REDIS_PORT', 6379);
        }

        for (const service of activeServices) {
            const blueprint = this.serviceCatalog.getByKey(service.serviceKey);
            if (blueprint.prismaModels) prismaBlocks.push(blueprint.prismaModels);
            Object.assign(extraPnpmDeps, blueprint.pnpmDependencies);

            const fullConfig = await this.platformServices.getFullDecryptedConfig(params.platformId, service.serviceKey);
            Object.assign(extraEnvVars, fullConfig);

            const generatorFn = SERVICE_FILE_GENERATORS[service.serviceKey];
            if (generatorFn) {
                const modules = await generatorFn(projectPath, fullConfig);
                extraModules.push(...modules);
            }
        }

        const schemaContent = await this.schemaBuilder.buildSchema(params.platformId, prismaBlocks);
        const entities = await this.schemaBuilder.getActiveEntitiesWithFields(params.platformId);
        const activeServiceKeys = new Set(activeServices.map((s) => s.serviceKey));
        const entitiesRequiringAuth = entities.filter(
            (e) => e.authProtectCreate || e.authProtectRead || e.authProtectUpdate || e.authProtectDelete,
        );
        if (entitiesRequiringAuth.length > 0 && !activeServiceKeys.has('auth-user')) {
            throw new BadRequestException(
                `Les entités suivantes exigent une authentification mais "Auth & User" n'est plus actif : ${entitiesRequiringAuth.map((e) => e.tableName).join(', ')}`,
            );
        }
        const relations = await this.prisma.relation.findMany({ where: { platformId: params.platformId } });
        const relationFieldsByEntity = computeRelationFieldsByEntity(
            entities.map((e) => ({ id: e.id, tableName: e.tableName })),
            relations,
        );
        const entityIdByTableName = new Map(entities.map((e) => [e.tableName, e.id]));
        
        await Promise.all([
            fs.writeFile(
                path.join(projectPath, 'package.json'),
                JSON.stringify(packageJsonObject(params.slug, extraPnpmDeps), null, 2),
            ),
            fs.writeFile(path.join(projectPath, 'nest-cli.json'), NEST_CLI_JSON),
            fs.writeFile(path.join(projectPath, 'tsconfig.json'), TSCONFIG_JSON),
            fs.writeFile(path.join(projectPath, 'prisma.config.ts'), prismaConfigTemplate()),
            fs.writeFile(
                path.join(projectPath, '.env'),
                envTemplate(params.databaseUrl, params.port, extraEnvVars),
            ),
            fs.writeFile(path.join(projectPath, 'prisma', 'schema.prisma'), schemaContent),
            fs.writeFile(path.join(projectPath, 'src', 'main.ts'), mainTsTemplate()),
            fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.service.ts'), prismaServiceTemplate()),
            fs.writeFile(path.join(projectPath, 'src', 'prisma', 'prisma.module.ts'), prismaModuleTemplate()),
        ]);

        await this.crudGenerator.generateModulesForEntities(
            projectPath,
            entities,
            relationFieldsByEntity,
            entityIdByTableName,
        );

        await fs.writeFile(
            path.join(projectPath, 'src', 'app.module.ts'),
            appModuleTemplate(entities, extraModules),
        );

        this.logger.log(`Projet écrit dans ${projectPath} (services: ${activeServices.map((s) => s.serviceKey).join(', ') || 'aucun'})`);
        return { projectPath };
    }

    private resolveProjectPath(slug: string): string {
        const root = this.configService.get<string>('GENERATED_PROJECTS_ROOT', 'generated');
        const absoluteRoot = path.isAbsolute(root) ? root : path.resolve(process.cwd(), root);
        return path.join(absoluteRoot, slug, 'backend');
    }
}