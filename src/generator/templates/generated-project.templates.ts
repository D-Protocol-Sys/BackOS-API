import { toPascalCase } from "../../common/utils/case.util";

/**
 * Builds the `package.json` object structure for a generated NestJS application.
 * Merges baseline dependencies (NestJS, Prisma v7 with Pg adapter, class-validator) 
 * with dynamic plugin dependencies required by activated service blueprints.
 * * @param slug - The project name identifier.
 * @param extraDependencies - Additional runtime package dependencies injected from service blueprints.
 * @returns Serializable package configuration object.
 */
export function packageJsonObject(slug: string, extraDependencies: Record<string, string>) {
    
    return {
        'name': slug,
        'version': '0.0.1',
        'private': true,
        scripts: {
            'build': 'nest build',
            'start': 'nest start',
            'start:dev': 'nest start --watch',
            'start:prod': 'node dist/main',
            'prisma:generate': 'prisma generate',
            'prisma:migrate': 'prisma migrate deploy',
        },
        dependencies: {
            '@nestjs/common': '^11.0.1',
            '@nestjs/core': '^11.0.1',
            '@nestjs/swagger': '^8.0.7',
            '@nestjs/platform-express': '^11.0.1',
            '@prisma/client': '^7.9.0',
            '@prisma/adapter-pg': '^7.9.0',
            'pg': '^8.13.0',
            'class-validator': '^0.14.1',
            'class-transformer': '^0.5.1',
            'reflect-metadata': '^0.2.2',
            'rxjs': '^7.8.1',
            'dotenv': '^16.4.5',
            ...extraDependencies,
        },
        devDependencies: {
            '@nestjs/cli': '^11.0.0',
            '@nestjs/schematics': '^11.0.0',
            '@types/node': '^24.0.0',
            '@types/express': '^5.0.0',
            'prisma': '^7.9.0',
            'tsx': '^4.19.0',
            'typescript': '^5.7.3',
        },
    };
}

/**
 * Static JSON configuration for the Nest CLI compiler in generated projects.
 * Automatically registers `@nestjs/swagger` compiler plugin to auto-generate OpenAPI metadata.
 */
export const NEST_CLI_JSON = JSON.stringify(
    {
        $schema: 'https://json.schemastore.org/nest-cli',
        collection: '@nestjs/schematics',
        sourceRoot: 'src',
        compilerOptions: { deleteOutDir: true, plugins: ['@nestjs/swagger'] },
    },
    null,
    2,
);

/**
 * Static JSON configuration for `tsconfig.json` in generated projects.
 * Configures decorator metadata support, ES target, and module path aliases 
 * pointing `@prismamodels/*` to generated Prisma Client outputs.
 */
export const TSCONFIG_JSON = JSON.stringify(
    {
        compilerOptions: {
            module: 'commonjs',
            declaration: true,
            target: 'ES2021',
            outDir: './dist',
            baseUrl: './',
            esModuleInterop: true,
            experimentalDecorators: true,
            emitDecoratorMetadata: true,
            strict: true,
            skipLibCheck: true,
            paths: {
                "@prismamodels/*": ["./prisma/generated/prisma/*"]
            }
        },
        include: [
            "src",
            "prisma/generated"
        ],
    },
    null,
    2,
);

/**
 * Generates the Prisma configuration file content for Prisma v7 config API.
 * Defines migration paths, schema location, and database source URL loading.
 */
export function prismaConfigTemplate(): string {
    return `
        import "dotenv/config";
        import { defineConfig, env } from "prisma/config";

        export default defineConfig({
            schema: "prisma/schema.prisma",
            migrations: { path: "prisma/migrations" },
            datasource: { url: env("DATABASE_URL") },
        });
    `;
}

/**
 * Generates the source code for `PrismaService` inside generated target apps.
 * Utilizes the modern Prisma PostgreSQL driver adapter (`PrismaPg`) 
 * and handles lifecycle database connection management (`$connect` / `$disconnect`).
 */
export function prismaServiceTemplate(): string {
    return `
        import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
        import { PrismaClient } from '@prismamodels/client';
        import { PrismaPg } from '@prisma/adapter-pg';

        @Injectable()
        export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {

            private readonly logger = new Logger(PrismaService.name);

            constructor() {
                const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
                super({ adapter });
            }

            async onModuleInit() {
                await this.$connect();
                this.logger.log('Database connection successfully established');
            }

            async onModuleDestroy() {
                await this.$disconnect();
            }
        }
    `;
}

/**
 * Generates source code for global `PrismaModule`.
 * Decorated with `@Global()` to make the singleton `PrismaService` available across 
 * all entity modules without explicit re-importing.
 */
export function prismaModuleTemplate(): string {
    return `
        import { Global, Module } from '@nestjs/common';
        import { PrismaService } from './prisma.service';

        @Global()
        @Module({
            providers: [PrismaService],
            exports: [PrismaService],
        })
        export class PrismaModule {}
    `;
}

/**
 * Generates the `main.ts` application bootstrap entrypoint for target generated apps.
 * Configures global pipes (`ValidationPipe`), global API route prefix (`/api`), 
 * and Swagger OpenAPI documentation served at `/api/docs`.
 */
export function mainTsTemplate(): string {
    return `
        import { NestFactory } from '@nestjs/core';
        import { ValidationPipe } from '@nestjs/common';
        import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
        import { AppModule } from './app.module';

        async function bootstrap() {
            const app = await NestFactory.create(AppModule);
            app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
            app.setGlobalPrefix('api');

            const swaggerConfig = new DocumentBuilder()
                .setTitle('Generated API by BPG')
                .setDescription('Automatically generated documentation based on platform definitions.')
                .setVersion('1.0')
                .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
                .build();
            const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
            SwaggerModule.setup('api/docs', app, swaggerDocument);

            const port = process.env.PORT || 4000;
            await app.listen(port);
            console.log(\`Generated API running on port \${port}\`);
            console.log(\`Documentation available at http://localhost:\${port}/api/docs\`);
        }
        bootstrap();
    `;
}

/**
 * Generates root `AppModule` class source code dynamically, assembling imports 
 * for dynamic entities and feature modules provided by blueprints.
 * * @param entities - List of platform entity table definitions.
 * @param extraModules - Injected module references generated from service blueprints.
 */
export function appModuleTemplate(
    entities: { tableName: string }[],
    extraModules: { name: string; importPath: string }[] = [],
): string {

    const entityImports = entities
        .map((e) => `import { ${toPascalCase(e.tableName)}Module } from './${e.tableName}/${e.tableName}.module';`)
        .join('\n');

    const extraImports = extraModules
        .map((m) => `import { ${m.name} } from '${m.importPath}';`)
        .join('\n');

    const moduleList = [
        'PrismaModule',
        ...extraModules.map((m) => m.name),
        ...entities.map((e) => `${toPascalCase(e.tableName)}Module`),
    ].join(',\n        ');

    return `
        import { Module } from '@nestjs/common';
        import { PrismaModule } from './prisma/prisma.module';
        ${extraImports}
        ${entityImports}

        @Module({
            imports: [
                ${moduleList},
            ],
        })
        export class AppModule {}
    `;
}

/**
 * Generates `.env` file string content for target applications, converting camelCase 
 * configuration keys into standard UPPER_SNAKE_CASE environment variable keys.
 * * @param databaseUrl - Target database connection string.
 * @param port - HTTP port assignment.
 * @param extraVars - Dictionary of additional service blueprint settings.
 */
export function envTemplate(
    databaseUrl: string,
    port: number,
    extraVars: Record<string, unknown> = {},
): string {

    const lines = [`DATABASE_URL="${databaseUrl}"`, `PORT=${port}`];

    for (const [key, value] of Object.entries(extraVars)) {
        lines.push(`${toEnvKey(key)}=${JSON.stringify(String(value))}`);
    }

    return lines.join('\n') + '\n';
}

/**
 * Helper function converting camelCase identifiers into standard UPPER_SNAKE_CASE 
 * env variable names (e.g., `smtpPassword` -> `SMTP_PASSWORD`).
 */
function toEnvKey(camelKey: string): string {
    return camelKey.replace(/([A-Z])/g, '_$1').toUpperCase();
}