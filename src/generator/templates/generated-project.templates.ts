import { toPascalCase } from "../../common/utils/case.util";
import { GENERATED_BACKEND_API_PREFIX, GENERATED_BACKEND_CONTAINER_PORT } from "../generated-backend.constants";

/**
 * Builds the `package.json` object structure for a generated NestJS application.
 * Merges baseline dependencies (NestJS, Prisma v7 with Pg adapter, class-validator) 
 * with dynamic plugin dependencies required by activated service blueprints.
 * * @param slug - The project name identifier.
 * @param extraDependencies - Additional runtime package dependencies injected from service blueprints.
 * @returns Serializable package configuration object.
 */
export function packageJsonObject(
    slug: string,
    extraDependencies: {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
    } = {},
) {
    
    return {
        'name': slug,
        'version': '0.0.1',
        'private': true,
        scripts: {
            'build': 'nest build',
            'start': 'nest start',
            'start:dev': 'nest start --watch',
            // NOTE: matches the actual tsc/nest-cli output layout (outDir './dist', sourceRoot
            // 'src' -> dist/src/main.js), and RuntimeManagerService.start() spawns this exact
            // path directly. Was previously 'node dist/main', which does not exist on disk.
            'start:prod': 'node dist/src/main.js',
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
            'bullmq': '^5.81.3',
            'pg': '^8.13.0',
            'class-validator': '^0.14.1',
            'class-transformer': '^0.5.1',
            'reflect-metadata': '^0.2.2',
            'rxjs': '^7.8.1',
            'dotenv': '^16.4.5',
            // Added alongside the loopback-binding / Swagger-in-prod security fix in
            // `mainTsTemplate()`, which now calls `app.use(helmet())` on every generated backend.
            'helmet': '^8.0.0',
            // Backs UploadsController (see uploadsMulterConfigTemplate()). Declared explicitly
            // rather than relying on it as a transitive dependency of `@nestjs/platform-express`
            // - pnpm's default strict, non-hoisted node_modules layout does NOT expose
            // transitive packages to `require()`, so omitting this would fail at runtime with
            // "Cannot find module 'multer'" the first time an upload is attempted.
            'multer': '^1.4.5-lts.1',
            ...(extraDependencies.dependencies ?? {}),
        },
        devDependencies: {
            '@nestjs/cli': '^11.0.0',
            '@nestjs/schematics': '^11.0.0',
            '@types/node': '^24.0.0',
            '@types/express': '^5.0.0',
            '@types/multer': '^1.4.12',
            // Types required by optional generated services.
            ...(extraDependencies.devDependencies ?? {}),
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
            datasource: { url: env("DATABASE_URL"), shadowDatabaseUrl: env("SHADOW_DATABASE_URL") },
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
 *
 * SECURITY FIX (bind address): `app.listen(port)` with no host argument binds Node's HTTP
 * server to `0.0.0.0` (every network interface) by default. Combined with the fact that
 * generated backends previously had no reverse proxy in front of them, this meant every
 * platform's dynamically-allocated port (see `GENERATION_PORT_RANGE_START/END`) was a
 * directly-reachable, unauthenticated-by-default entry point on any network path that could
 * reach the host - a much larger attack surface than intended, and dependent entirely on
 * external firewall configuration to stay safe.
 *
 * Generated backends now bind ONLY to `127.0.0.1` (loopback) unless explicitly overridden via
 * `HOST`. The parent BackOS process is the sole component allowed to reach them, through the
 * gateway reverse proxy in `src/gateway/` (see `GATEWAY_README.md`), which is what actually
 * exposes `https://<your-domain>/generated/<slug>/...` to the public internet. A generated
 * backend can no longer be reached directly by an external client, regardless of firewall
 * configuration - this is "secure by default" rather than "secure if the network is configured
 * correctly".
 *
 * SECURITY FIX (Swagger in production): the interactive API documentation, which lists every
 * route and DTO shape, is now only mounted outside of `production` - publishing a full API
 * surface map to unauthenticated users is unnecessary reconnaissance information in a
 * production deployment.
 *
 * CORS: a generated backend is meant to be called from a browser running on a DIFFERENT origin
 * than the backend itself (e.g. a "portfolio" platform's own public frontend, plus the BackOS
 * "backoffice" frontend used to fill its database) - so without CORS configured, every one of
 * those calls would be silently blocked by the browser. `CORS_ORIGINS` is written to this
 * project's `.env` at generation time (see `envTemplate()` and
 * `ProjectScaffolderService.scaffold()`) from two sources: the platform's own `url` field
 * (its public frontend) and BackOS's own `FRONTEND_URL` (the backoffice used to manage this
 * platform's data). Origins are comma-separated; unset/blank entries are dropped automatically
 * by `ProjectScaffolderService`, so this list only ever contains real, usable origins - if it
 * ends up empty, CORS is left OFF (default Nest behaviour: same-origin only) rather than wide
 * open, so a platform with no known frontend never accidentally allows every origin.
 *
 * PORT / ENV PRECEDENCE (bugfix): this used to be `import 'dotenv/config'`, which uses the
 * `dotenv` package's DEFAULT behaviour of *not* overriding a variable that is already present
 * in `process.env` when the process starts. That is the wrong default for a generated backend:
 * whatever process launches this one (`RuntimeManagerService`, a container runtime, systemd,
 * a developer's shell, ...) may already have its OWN unrelated `PORT` (or `HOST`, `DATABASE_URL`,
 * etc.) set in its environment, and if that leaks into this process's environment before
 * `dotenv` runs, this backend would silently bind to THAT value instead of the one written to
 * its own \`.env\` file at generation time (\`envTemplate()\`) - which is exactly how a generated
 * backend could end up listening on the ORCHESTRATOR's own port instead of its assigned one.
 * Loading with \`{ override: true }\` makes this project's own \`.env\` file authoritative for
 * its own process, no matter what it happened to inherit. See also the explicit \`PORT\`/\`HOST\`
 * passed by \`RuntimeManagerService.start()\`, which is the other half of this fix.
 */
export function mainTsTemplate(): string {
    return `
        import * as dotenv from 'dotenv';
        // See the module-level comment on mainTsTemplate(): this project's own .env is always
        // authoritative for THIS process, regardless of whatever it may have inherited.
        dotenv.config({ override: true });

        import { NestFactory } from '@nestjs/core';
        import { ValidationPipe } from '@nestjs/common';
        import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
        import helmet from 'helmet';
        import { AppModule } from './app.module';

        const API_PREFIX = '${GENERATED_BACKEND_API_PREFIX}';

        async function bootstrap() {
            const app = await NestFactory.create(AppModule);

            // Baseline HTTP security headers (same defaults used by the parent BackOS API).
            app.use(helmet());

            // CORS: see the module-level comment above for where CORS_ORIGINS comes from.
            const corsOrigins = (process.env.CORS_ORIGINS || '')
                .split(',')
                .map((origin) => origin.trim())
                .filter(Boolean);

            if (corsOrigins.length > 0) {
                app.enableCors({ origin: corsOrigins, credentials: true });
                console.log(\`CORS enabled for: \${corsOrigins.join(', ')}\`);
            } else {
                console.log('CORS_ORIGINS is empty - CORS stays disabled (same-origin only).');
            }

            app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
            // Deliberately distinct from the orchestrator's own '/api' prefix - see
            // GENERATED_BACKEND_API_PREFIX for why - and shared with the gateway's pathRewrite
            // so the two can never silently drift apart.
            app.setGlobalPrefix(API_PREFIX);

            const isProduction = process.env.NODE_ENV === 'production';

            if (!isProduction) {
                const swaggerConfig = new DocumentBuilder()
                    .setTitle('Generated API by BPG')
                    .setDescription('Automatically generated documentation based on platform definitions.')
                    .setVersion('1.0')
                    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
                    .build();
                const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
                SwaggerModule.setup(\`\${API_PREFIX}/docs\`, app, swaggerDocument);
            }

            // process.env.PORT/HOST are now guaranteed correct for THIS process: either sourced
            // from this project's own .env (via the override:true load above), or explicitly
            // set by RuntimeManagerService.start() at spawn time - see that file's comments.
            const port = process.env.PORT || ${GENERATED_BACKEND_CONTAINER_PORT};

            // SECURITY: loopback-only by default - see the module-level comment above. This
            // backend is reached from the outside world exclusively through the BackOS
            // gateway reverse proxy, never directly.
            const host = process.env.HOST || '127.0.0.1';

            await app.listen(port, host);
            console.log(\`Generated API listening on \${host}:\${port} (internal only)\`);
            if (!isProduction) {
                console.log(\`Documentation available at http://\${host}:\${port}/\${API_PREFIX}/docs\`);
            }
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
 * @param host - Bind address for the generated backend's HTTP server. Defaults to the
 *   loopback interface (`127.0.0.1`) so the process is only reachable from other processes
 *   on the same machine (i.e. the BackOS gateway reverse proxy) - never directly from the
 *   public internet. See the security note on `mainTsTemplate()` for the full rationale.
 * @param corsOrigins - Frontend origins allowed to call this generated backend directly in the
 *   browser (e.g. the platform's own public site, plus the BackOS backoffice). Written as a
 *   single comma-separated `CORS_ORIGINS` variable and read back by `mainTsTemplate()`. See the
 *   CORS note on `mainTsTemplate()` for the full rationale.
 */
export function envTemplate(
    databaseUrl: string,
    port: number,
    extraVars: Record<string, unknown> = {},
    host: string = '127.0.0.1',
    corsOrigins: string[] = [],
): string {

    const lines = [
        `DATABASE_URL="${databaseUrl}"`,
        `PORT=${port}`,
        `HOST=${host}`,
        `CORS_ORIGINS=${formatEnvValue(corsOrigins.join(','))}`,
    ];

    for (const [key, value] of Object.entries(extraVars)) {
        // Only scalar settings can live in a `.env` line. A structured setting (e.g. the profile
        // field definitions of the Auth & User service, which is an array of objects) is consumed
        // by its own code generator instead - stringifying it here would emit `[object Object]`.
        if (value === undefined || value === null || typeof value === 'object') continue;
        lines.push(`${toEnvKey(key)}=${formatEnvValue(String(value))}`);
    }

    return lines.join('\n') + '\n';
}

/**
 * Formats one `.env` value so that BOTH consumers of this file read the same string:
 *   - `dotenv` (process runtime, and `main.ts`), which strips surrounding quotes;
 *   - `docker run --env-file` (Docker runtime), which does NOT - it hands the value over
 *     literally, so `KEY="abc"` would reach the container as the 5-character string `"abc"`,
 *     quotes included (breaking e.g. `CORS_ORIGINS` and `SMTP_HOST`).
 * A value made only of characters that are literal in both parsers is therefore written bare;
 * anything else falls back to a JSON-quoted string, exactly as before.
 */
function formatEnvValue(value: string): string {
    if (value === '') return '';
    return /^[A-Za-z0-9_@.:/+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Helper function converting camelCase identifiers into standard UPPER_SNAKE_CASE 
 * env variable names (e.g., `smtpPassword` -> `SMTP_PASSWORD`).
 */
function toEnvKey(camelKey: string): string {
    return camelKey.replace(/([A-Z])/g, '_$1').toUpperCase();
}

/**
 * Generates the source code for a HealthCheck Controller template.
 * Educational Note: Performs a lightweight `$queryRaw\`SELECT 1\`` database ping
 * to provide a clear 'ok' or 'degraded' status without heavily loading the database.
 */
export function healthControllerTemplate(): string {
    return `
        import { Controller, Get } from '@nestjs/common';
        import { PrismaService } from '../prisma/prisma.service';

        @Controller('health')
        export class HealthController {
            constructor(private readonly prisma: PrismaService) {}

            @Get()
            async check() {
                let database: 'ok' | 'error' = 'ok';
                try {
                    await this.prisma.$queryRaw\`SELECT 1\`;
                } catch {
                    database = 'error';
                }
                return { status: database === 'ok' ? 'ok' : 'degraded', database, uptime: process.uptime() };
            }
        }
    `;
}

/**
 * Generates the source code for a NestJS Health Module template.
 */
export function healthModuleTemplate(): string {
    return `
        import { Module } from '@nestjs/common';
        import { HealthController } from './health.controller';

        @Module({ controllers: [HealthController] })
        export class HealthModule {}
    `;
}

/**
 * Generates the Multer configuration for a generated backend's `UploadsController` - the
 * counterpart to the frontend's `uploadToGeneratedBackend()` (`lib/api/generated-records.ts`),
 * which every `IMAGE` / `VIDEO` / `MEDIA` / `FILE` entity field (see `schema-builder.service.ts`)
 * ultimately calls - including those declared as ARRAY fields (a gallery of images and videos):
 * the client uploads each file separately, then stores the returned URLs together in the array.
 *
 * Mirrors the orchestrator's OWN `files/multer.config.ts` conventions on purpose (random
 * `crypto.randomUUID()` filenames - never the client-supplied name, which eliminates path
 * traversal and collisions - plus a strict MIME allowlist and a hard size cap enforced at the
 * Multer layer, not just client-side): a generated backend runs arbitrary end-users' uploads
 * with no additional sandboxing beyond what this file provides, so it deserves the same
 * discipline as the orchestrator's own upload path, not a lighter-weight version of it.
 *
 * VIDEOS (mp4 / webm / mov): allowed up to 100 MB, versus 5 MB for images and PDFs. Multer only
 * supports a single `fileSize` limit per request, so it is set to the video ceiling and the
 * tighter image/document cap is enforced immediately afterwards in `UploadsController`. Every
 * upload's magic bytes are also checked against its declared MIME type (same idea as the
 * orchestrator's `files/file-signature.util.ts`), since the multipart `Content-Type` is entirely
 * client-controlled.
 *
 * The allowlist and the 5 MB image cap intentionally match the client-side check already in
 * `uploadToGeneratedBackend()` (`ALLOWED_UPLOAD_TYPES` / `MAX_UPLOAD_BYTES`) - that check is
 * documented there as "a UX nicety only", and this is the enforcement it was always assuming
 * existed server-side. NOTE: that client-side allowlist must now also accept the three video
 * MIME types, and its size cap must become per-kind, or the browser will refuse videos before
 * they ever reach this backend.
 */
export function uploadsMulterConfigTemplate(): string {
    return `
        import { diskStorage } from 'multer';
        import * as crypto from 'crypto';
        import * as path from 'path';
        import * as fs from 'fs';
        import { BadRequestException, ForbiddenException } from '@nestjs/common';

        // Resolves relative to this process's cwd (the project root - see RuntimeManagerService
        // / DockerRuntimeManagerService, both of which spawn/run from there), unless overridden.
        // DockerRuntimeManagerService explicitly sets this to a bind-mounted, writable path when
        // Docker isolation is active, since the rest of the container's filesystem is read-only.
        const uploadDir = process.env.UPLOADS_DIR ?? './uploads';
        fs.mkdirSync(uploadDir, { recursive: true });

        export type UploadKind = 'image' | 'video' | 'file';

        interface UploadTypeSpec {
            extension: string;
            kind: UploadKind;
        }

        /** MIME type -> stored extension + coarse kind. The single source of truth for what may be uploaded. */
        export const ALLOWED_UPLOAD_TYPES: Record<string, UploadTypeSpec> = {
            'image/jpeg': { extension: 'jpg', kind: 'image' },
            'image/png': { extension: 'png', kind: 'image' },
            'image/gif': { extension: 'gif', kind: 'image' },
            'image/webp': { extension: 'webp', kind: 'image' },
            'video/mp4': { extension: 'mp4', kind: 'video' },
            'video/webm': { extension: 'webm', kind: 'video' },
            'video/quicktime': { extension: 'mov', kind: 'video' },
            'application/pdf': { extension: 'pdf', kind: 'file' },
        };

        // Images and documents keep the original 5 MB cap (matches the frontend's MAX_UPLOAD_BYTES).
        export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
        // Videos are much larger by nature. Also the hard ceiling handed to Multer below, since Multer
        // applies ONE fileSize limit per request and cannot vary it by MIME type - the tighter per-kind
        // cap for images/documents is enforced right after the upload, in UploadsController.
        export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

        export function maxBytesFor(kind: UploadKind): number {
            return kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
        }

        export const uploadsMulterOptions = {
            storage: diskStorage({
                destination: uploadDir,
                filename: (_req: unknown, file: Express.Multer.File, callback: (error: Error | null, filename: string) => void) => {
                    const extension = ALLOWED_UPLOAD_TYPES[file.mimetype]?.extension ?? 'bin';
                    callback(null, \`\${crypto.randomUUID()}.\${extension}\`);
                },
            }),
            fileFilter: (req: { user?: { type?: string } }, file: Express.Multer.File, callback: (error: Error | null, accept: boolean) => void) => {
                const spec = ALLOWED_UPLOAD_TYPES[file.mimetype];
                if (!spec) {
                    return callback(new BadRequestException(\`Unsupported file type: \${file.mimetype}\`), false);
                }
                // Videos are reserved to internal accounts (an external user is a visitor: images and
                // documents for their own profile are fine, 100 MB videos are not). \`req.user\` is already
                // set here - the auth guards run before this interceptor.
                if (spec.kind === 'video' && req.user?.type === 'external') {
                    return callback(new ForbiddenException('Video uploads are reserved to internal accounts.'), false);
                }
                callback(null, true);
            },
            limits: { fileSize: MAX_VIDEO_BYTES, files: 1 },
        };

        export function resolveUploadsDir(): string {
            return path.resolve(uploadDir);
        }

        /** Inverse of ALLOWED_UPLOAD_TYPES - used by UploadsController to set a correct Content-Type
         * when serving a file back, since nothing else records it (this backend has no database table
         * for uploads - they're served straight off disk by filename). */
        export function mimeTypeForExtension(extension: string): string {
            const entry = Object.entries(ALLOWED_UPLOAD_TYPES).find(([, spec]) => spec.extension === extension);
            return entry?.[0] ?? 'application/octet-stream';
        }

        const startsWith = (head: Buffer, bytes: number[]): boolean =>
            head.length >= bytes.length && bytes.every((byte, index) => head[index] === byte);

        /** ISO base media (MP4 / MOV): a 4-byte box size, then a 4-byte box type at offset 4. */
        const boxTypeAt4 = (head: Buffer): string => head.subarray(4, 8).toString('latin1');

        /**
         * Content-based check: the \`Content-Type\` of a multipart field is whatever the client says it
         * is, so it is never trusted on its own. Confirms the first bytes actually written to disk match
         * the magic-byte signature of the MIME type that was claimed.
         */
        export function matchesFileSignature(mimeType: string, head: Buffer): boolean {
            switch (mimeType) {
                case 'image/jpeg':
                    return startsWith(head, [0xff, 0xd8, 0xff]);
                case 'image/png':
                    return startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
                case 'image/gif':
                    return startsWith(head, [0x47, 0x49, 0x46, 0x38]);
                case 'image/webp':
                    // "RIFF" + 4-byte size + "WEBP"
                    return startsWith(head, [0x52, 0x49, 0x46, 0x46]) && head.subarray(8, 12).toString('latin1') === 'WEBP';
                case 'application/pdf':
                    return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]);
                case 'video/webm':
                    // EBML header (shared with Matroska).
                    return startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]);
                case 'video/mp4':
                    return boxTypeAt4(head) === 'ftyp';
                case 'video/quicktime':
                    // Modern .mov files start with "ftyp", but older QuickTime files start directly with
                    // a "moov" / "mdat" / "wide" / "free" / "skip" atom.
                    return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(boxTypeAt4(head));
                default:
                    return false;
            }
        }
    `;
}

/**
 * Generates the `UploadsController` for a generated backend: accepts a single multipart file
 * upload and serves it back by filename (with HTTP Range support, so videos can be played and
 * seeked in a browser).
 *
 * ACCESS:
 *   - `GET /uploads/:filename` is public (files are shown on the platform's public pages; their
 *     names are random UUIDs, never guessable).
 *   - `POST /uploads` requires a signed-in account (JwtAuthGuard) whenever the platform has the
 *     Auth & User service: internal accounts may upload images, PDFs and videos, external users
 *     (visitors) images and PDFs only, and only a few per hour. Without Auth & User there is
 *     nobody to authenticate, so the endpoint stays open - but every platform, authenticated or
 *     not, is protected by a disk quota (see `UploadPolicyGuard`) so uploads can never fill the disk.
 *   - The back-office must therefore send an INTERNAL access token when uploading
 *     (see `uploadToGeneratedBackend()` in the frontend's `generated-records.ts`).
 */
export function uploadsControllerTemplate(authEnabled: boolean): string {
    const authImports = authEnabled
        ? "import { ApiBearerAuth } from '@nestjs/swagger';\nimport { JwtAuthGuard } from '../common/guards/jwt-auth.guard';"
        : '';
    // Uploading requires a signed-in account whenever the platform has the Auth & User service;
    // without it there is nobody to authenticate, so only the storage policy applies.
    const guards = authEnabled
        ? "@UseGuards(JwtAuthGuard, UploadPolicyGuard)\n    @ApiBearerAuth('access-token')"
        : '@UseGuards(UploadPolicyGuard)';
    return `
        import { Controller, Post, Get, Param, UseGuards, UseInterceptors, UploadedFile, BadRequestException, NotFoundException, PayloadTooLargeException, Res } from '@nestjs/common';
        import { FileInterceptor } from '@nestjs/platform-express';
        import type { Response } from 'express';
        import * as fs from 'fs';
        import * as path from 'path';

        ${authImports}
        import { UploadPolicyGuard } from './uploads.policy.guard';
        import {
            uploadsMulterOptions,
            resolveUploadsDir,
            mimeTypeForExtension,
            matchesFileSignature,
            maxBytesFor,
            ALLOWED_UPLOAD_TYPES,
        } from './uploads.multer-config';

        // Matches exactly what multer's own \`diskStorage.filename()\` produces
        // (crypto.randomUUID() + '.' + extension) - used to reject any hand-crafted filename
        // before it ever reaches the filesystem, as defense in depth alongside path.resolve()
        // + a containment check below (belt and suspenders: either one alone would already
        // prevent path traversal here, since multer never generates a name outside this shape).
        const SAFE_FILENAME_PATTERN = /^[0-9a-f-]{36}\\.[a-zA-Z0-9]+$/;

        /** Reads only the first bytes of a file - enough for every signature check. */
        async function readHead(filePath: string): Promise<Buffer> {
            const handle = await fs.promises.open(filePath, 'r');
            try {
                const buffer = Buffer.alloc(16);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                return buffer.subarray(0, bytesRead);
            } finally {
                await handle.close();
            }
        }

        async function discard(filePath: string): Promise<void> {
            await fs.promises.unlink(filePath).catch(() => undefined);
        }

        @Controller('uploads')
        export class UploadsController {
            /**
             * Accepts ONE file (multipart field "file"): an image (jpeg/png/gif/webp), a video
             * (mp4/webm/mov) or a pdf. To fill an ARRAY field (a gallery, an "illustration" list...) the
             * client calls this once per file, then sends the returned \`url\`s together in one array.
             *
             * Access: see UploadPolicyGuard (disk quota for everyone) and, when the platform has the Auth &
             * User service, the JWT requirement above - external users may upload images / documents only.
             */

    ${guards}
            @Post()
            @UseInterceptors(FileInterceptor('file', uploadsMulterOptions))
            async upload(@UploadedFile() file: Express.Multer.File) {
                if (!file) {
                    throw new BadRequestException('No file was provided (expected multipart field "file").');
                }

                const spec = ALLOWED_UPLOAD_TYPES[file.mimetype];

                // Multer's own limit is the (large) video ceiling; images and documents have a tighter cap.
                if (file.size > maxBytesFor(spec.kind)) {
                    await discard(file.path);
                    throw new PayloadTooLargeException(\`This \${spec.kind} exceeds the \${maxBytesFor(spec.kind) / 1024 / 1024} MB limit.\`);
                }

                // The declared MIME type is client-controlled - verify what was actually written.
                if (!matchesFileSignature(file.mimetype, await readHead(file.path))) {
                    await discard(file.path);
                    throw new BadRequestException('The file content does not match its declared type.');
                }

                // Relative path only - this backend doesn't know its own public gateway URL
                // (BackOS's \`GENERATED_BACKEND_GATEWAY_PREFIX\`); the frontend combines this
                // with that base itself. See uploadToGeneratedBackend() in generated-records.ts.
                return {
                    url: \`/uploads/\${file.filename}\`,
                    kind: spec.kind,
                    mimeType: file.mimetype,
                    size: file.size,
                };
            }

            @Get(':filename')
            download(@Param('filename') filename: string, @Res() res: Response) {
                if (!SAFE_FILENAME_PATTERN.test(filename)) {
                    throw new NotFoundException('File not found.');
                }

                const uploadsDir = resolveUploadsDir();
                const diskPath = path.join(uploadsDir, filename);
                // Defense in depth: confirms the resolved path is still inside uploadsDir even
                // after the regex check above, in case that pattern is ever loosened later.
                if (!diskPath.startsWith(uploadsDir + path.sep) || !fs.existsSync(diskPath)) {
                    throw new NotFoundException('File not found.');
                }

                // sendFile (rather than piping a read stream) is what gives us HTTP Range support -
                // browsers (Safari especially) refuse to play or seek inside a <video> whose source
                // cannot answer "206 Partial Content".
                res.sendFile(
                    diskPath,
                    {
                        dotfiles: 'deny',
                        headers: {
                            'Content-Type': mimeTypeForExtension(path.extname(filename).slice(1)),
                            'X-Content-Type-Options': 'nosniff',
                            // helmet() defaults to \`same-origin\`, which makes a browser refuse to render
                            // an <img>/<video> from this backend on a DIFFERENT origin (the platform's
                            // own public site) even though CORS allows it - CORP is a separate check.
                            'Cross-Origin-Resource-Policy': 'cross-origin',
                            // Safe to cache aggressively and immutably - filenames are random UUIDs,
                            // never reused or overwritten once uploaded.
                            'Cache-Control': 'public, max-age=31536000, immutable',
                        },
                    },
                    (error) => {
                        if (error && !res.headersSent) {
                            res.status(404).json({ statusCode: 404, message: 'File not found.' });
                        }
                    },
                );
            }
        }
    `;
}

/**
 * Generates the guard that protects `POST /uploads` before the request body is read: a disk quota
 * for everybody, plus a size and hourly cap for external users. See the file's own comments.
 */
export function uploadsPolicyGuardTemplate(): string {
    return `
        import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable, PayloadTooLargeException } from '@nestjs/common';
        import * as fs from 'fs';
        import * as path from 'path';
        import { MAX_IMAGE_BYTES, resolveUploadsDir } from './uploads.multer-config';

        const MB = 1024 * 1024;

        // Total disk space the uploads folder may occupy. Without a ceiling, anyone able to upload could
        // fill the server's disk (and take every other platform on it down with it). Override with
        // MAX_UPLOADS_TOTAL_MB in the environment.
        const QUOTA_BYTES = (Number(process.env.MAX_UPLOADS_TOTAL_MB) || 2048) * MB;

        // An external user (a visitor with a free account) may only send small files, and only a few per hour.
        const MAX_EXTERNAL_UPLOAD_BYTES = MAX_IMAGE_BYTES + 256 * 1024; // + multipart framing overhead
        const EXTERNAL_UPLOADS_PER_HOUR = 20;
        const ONE_HOUR_MS = 60 * 60 * 1000;

        /**
         * Runs BEFORE the request body is read - so a refused upload costs no disk and no bandwidth:
         *   1. the uploads folder must have room left (everybody);
         *   2. an external user must announce a small body (Content-Length) and stay under an hourly cap.
         * (Whether the caller is signed in at all is decided by JwtAuthGuard, which precedes this guard on
         * platforms that have the Auth & User service.)
         */
        @Injectable()
        export class UploadPolicyGuard implements CanActivate {
            private readonly externalUploads = new Map<string, number[]>();
            private cachedUsage: { bytes: number; at: number } | null = null;

            async canActivate(context: ExecutionContext): Promise<boolean> {
                const request = context.switchToHttp().getRequest();
                const declaredLength = Number(request.headers['content-length']);
                const incoming = Number.isFinite(declaredLength) ? declaredLength : 0;

                if (request.user?.type === 'external') {
                    if (!Number.isFinite(declaredLength)) {
                        throw new HttpException('A Content-Length header is required.', HttpStatus.LENGTH_REQUIRED);
                    }
                    if (declaredLength > MAX_EXTERNAL_UPLOAD_BYTES) {
                        throw new PayloadTooLargeException('This file is too large (limit: ' + MAX_IMAGE_BYTES / MB + ' MB).');
                    }
                    this.assertExternalRateLimit(request.user.userId);
                }

                if ((await this.usedBytes()) + incoming > QUOTA_BYTES) {
                    throw new HttpException('The storage space of this platform is full.', HttpStatus.INSUFFICIENT_STORAGE);
                }
                // Count the accepted upload right away instead of waiting for the next disk read, so a burst of
                // simultaneous uploads cannot all slip under the ceiling together. (Slightly pessimistic if one
                // is refused later on - corrected at the next refresh.)
                if (this.cachedUsage) this.cachedUsage.bytes += incoming;
                return true;
            }

            private assertExternalRateLimit(userId: string): void {
                const now = Date.now();
                const recent = (this.externalUploads.get(userId) ?? []).filter((at) => now - at < ONE_HOUR_MS);
                if (recent.length >= EXTERNAL_UPLOADS_PER_HOUR) {
                    throw new HttpException('Too many uploads, please try again later.', HttpStatus.TOO_MANY_REQUESTS);
                }
                recent.push(now);
                this.externalUploads.set(userId, recent);
            }

            /** Bytes currently stored, recomputed at most every 5 seconds. */
            private async usedBytes(): Promise<number> {
                if (this.cachedUsage && Date.now() - this.cachedUsage.at < 5000) return this.cachedUsage.bytes;

                const dir = resolveUploadsDir();
                let bytes = 0;
                try {
                    for (const name of await fs.promises.readdir(dir)) {
                        const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
                        if (stat?.isFile()) bytes += stat.size;
                    }
                } catch {
                    // Folder not created yet: nothing stored.
                }
                this.cachedUsage = { bytes, at: Date.now() };
                return bytes;
            }
        }
    `;
}

export function uploadsModuleTemplate(): string {
    return `
        import { Module } from '@nestjs/common';
        import { UploadsController } from './uploads.controller';

        @Module({ controllers: [UploadsController] })
        export class UploadsModule {}
    `;
}

/**
 * Generates a multi-stage `Dockerfile` for a generated backend, used by
 * `DockerRuntimeManagerService` to run each platform in its own isolated container instead of
 * as a bare `node` child process on the host.
 *
 * WHY IN-IMAGE `prisma generate` (not the host-generated client from the build pipeline):
 * Prisma's query engine binary is architecture/libc-specific (e.g. glibc on a typical dev
 * host vs musl on `node:*-alpine`). Regenerating the client INSIDE the builder stage guarantees
 * the engine binary always matches the container it will actually run in, regardless of what
 * host OS built the image. Only `schema.prisma` and `migrations/` are copied in - never the
 * host's own `prisma/generated` output.
 *
 * WHY MIGRATIONS ARE NOT RUN HERE: `prisma migrate deploy` still runs once on the host as part
 * of the existing generation pipeline (`GenerationProcessor`, STEP 5), before this image is
 * even built. Baking migration execution into container start would mean every container start
 * (including simple restarts) re-runs migrations, and would need real DB credentials available
 * at container-start time for a step that should only ever happen once per schema change.
 *
 * ISOLATION properties this gives each generated backend, beyond the plain-process model:
 *   - Its own filesystem and process namespace (a runaway/compromised generated backend cannot
 *     see or signal-kill other platforms' processes, or the orchestrator's own process, the way
 *     a bare `child_process.spawn` on the shared host can).
 *   - Hard resource limits (CPU/memory) enforced by the container runtime, so one platform's
 *     bug/abuse cannot starve the host or other platforms - not achievable with a bare `spawn`.
 *   - Runs as a dedicated non-root `app` user, with the runtime filesystem read-only except for
 *     an explicit `/tmp` tmpfs (see `DockerRuntimeManagerService`).
 *   - Still loopback-only from the outside: `DockerRuntimeManagerService` publishes the
 *     container's fixed internal port ONLY to `127.0.0.1:<allocatedPort>` on the host, so the
 *     "only reachable through the BackOS gateway" security property from `mainTsTemplate()` is
 *     preserved unchanged.
 */
export function dockerfileTemplate(): string {
    return `# syntax=docker/dockerfile:1.7
# Auto-generated by ProjectScaffolderService - do not edit by hand, it will be overwritten on
# the next generation.

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY .npmrc pnpm-workspace.yaml ./
RUN pnpm install --no-frozen-lockfile
COPY tsconfig.json nest-cli.json prisma.config.ts ./
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations
# prisma.config.ts (see prismaConfigTemplate()) eagerly resolves env("DATABASE_URL") AND
# env("SHADOW_DATABASE_URL") just to load the config, even though \`prisma generate\` itself
# never connects to a database - it only reads prisma/schema.prisma. Neither real value exists
# yet at build time (the real ones are supplied via --env-file at container start - see
# DockerRuntimeManagerService.start() - which always overrides these build-time defaults), so
# syntactically-valid placeholders are enough to get past PrismaConfigEnvError here without
# needing real database connectivity in the builder stage.
ENV DATABASE_URL="postgresql://user:password@localhost:5432/db?schema=public"
ENV SHADOW_DATABASE_URL="postgresql://user:password@localhost:5432/db_shadow?schema=public"
# Regenerated here (not copied from the host) so the query engine binary always matches this
# image's platform/libc - see the module-level comment on dockerfileTemplate().
RUN pnpm exec prisma generate
COPY src ./src
RUN pnpm run build

FROM node:22-alpine AS runtime
WORKDIR /app
RUN corepack enable \\
    && addgroup -S app && adduser -S app -G app
ENV NODE_ENV=production
COPY package.json ./
COPY pnpm-lock.yaml* ./
COPY .npmrc pnpm-workspace.yaml ./
RUN pnpm install --prod --no-frozen-lockfile \\
    && rm -rf "$(pnpm store path)"
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
USER app
EXPOSE ${GENERATED_BACKEND_CONTAINER_PORT}
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \\
    CMD node -e "fetch('http://127.0.0.1:${GENERATED_BACKEND_CONTAINER_PORT}/${GENERATED_BACKEND_API_PREFIX}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
`;
}

/**
 * Generates the `.npmrc` paired with `dockerfileTemplate()`.
 *
 * WHY THIS EXISTS: pnpm 11 turned on a supply-chain-protection default,
 * `minimumReleaseAge` (1440 minutes / 24h - see https://pnpm.io/supply-chain-security),
 * which refuses to resolve/install ANY lockfile entry published less than 24h ago. This is a
 * sane default for hand-maintained apps, but it actively breaks reproducible builds here:
 * `pnpm-lock.yaml` is generated fresh at scaffold time from whatever the registry's "latest"
 * resolution is at that moment, and fast-moving transitive deps pulled in by NestJS/webpack
 * tooling (`browserslist` -> `caniuse-lite` / `electron-to-chromium`, which both publish
 * new versions roughly daily) are frequently younger than 24h. Since `buildImage()` in
 * `DockerRuntimeManagerService` rebuilds the image on every `start()` (not just once at
 * generation time), a lockfile entry that was old enough yesterday can violate the policy
 * again the next time someone (re)starts the container, without ANY dependency change on the
 * user's part - surfacing as an opaque `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` deep inside
 * `docker build` output.
 *
 * Setting it to 0 here restores the old (pre-v11) pnpm behavior of trusting whatever the
 * lockfile / registry resolution says, which is the right tradeoff for a backend whose
 * dependency set was already deterministically resolved and committed by
 * `ProjectScaffolderService` - re-litigating "is this transitive dep too new" on every
 * container (re)build adds no real security benefit here and only produces flaky, host-clock
 * -dependent build failures. Copied into BOTH Docker stages (see `dockerfileTemplate()`)
 * since each stage runs its own independent `pnpm install`.
 */
export function npmrcTemplate(): string {
    return `# Auto-generated by ProjectScaffolderService - do not edit by hand, it will be overwritten on
# the next generation. See the comment on npmrcTemplate() for why this is needed.
minimum-release-age=0
`;
}

/**
 * Generates the `pnpm-workspace.yaml` paired with `dockerfileTemplate()` / `npmrcTemplate()`.
 *
 * WHY THIS EXISTS (on top of the .npmrc above): as of pnpm 11, `.npmrc` is INI-parsed for
 * auth/registry settings ONLY - every other pnpm setting, including `minimumReleaseAge`, is
 * silently ignored there and must live in this YAML file instead (or the global
 * `~/.config/pnpm/config.yaml`). Since `package.json` has no pinned `packageManager` field,
 * `corepack enable` fetches whatever the latest pnpm release is at build time (currently
 * 11.x), so relying on the `.npmrc` form alone works for pnpm <11 but is a silent no-op on
 * 11+ - which is exactly what caused the build to still fail with
 * `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` even after `.npmrc` was added. Shipping BOTH files
 * covers pnpm <11 (reads `.npmrc`) and pnpm 11+ (reads this file) without needing to know or
 * pin the exact pnpm version the build happens to resolve.
 *
 * Also carries `allowBuilds` (pnpm 11's replacement for the old `onlyBuiltDependencies` /
 * `.npmrc` `enable-pre-post-scripts`): pnpm 11 made `strictDepBuilds` true by default, so any
 * dependency's `postinstall`/`install`/`preinstall` script is skipped UNLESS the package is
 * explicitly allowed here - failing the whole `pnpm install` with `ERR_PNPM_IGNORED_BUILDS`
 * rather than silently skipping it. The four packages below all need their build script to
 * actually run for the generated backend to work, not just to satisfy pnpm:
 *   - `prisma` / `@prisma/engines` - download the Prisma query-engine binary for this platform;
 *     without it, `pnpm exec prisma generate` (see `dockerfileTemplate()`) and every Prisma
 *     query at runtime fail.
 *   - `esbuild` - downloads the correct native `esbuild` binary for the build platform; NestJS's
 *     CLI build (`pnpm run build`) shells out to it.
 *   - `@scarf/scarf` - a transitive dep of Prisma tooling that no-ops without its install script,
 *     but pnpm still refuses the whole install over it while it's unlisted.
 */
export function pnpmWorkspaceYamlTemplate(): string {
    return `# Auto-generated by ProjectScaffolderService - do not edit by hand, it will be overwritten on
# the next generation. See the comment on pnpmWorkspaceYamlTemplate() for why this is needed.
minimumReleaseAge: 0
allowBuilds:
  prisma: true
  '@prisma/engines': true
  esbuild: true
  '@scarf/scarf': true
  bcrypt: true
  msgpackr-extract: true
`;
}

/**
 * Generates the `.dockerignore` paired with `dockerfileTemplate()` - keeps the host's
 * `node_modules`, build output, logs, and secrets out of the Docker build context entirely
 * (defense in depth alongside the `--prod`/allowlisted env work in `DockerRuntimeManagerService`;
 * a build context is a broader leak surface than a spawned process's env would ever be).
 */
export function dockerignoreTemplate(): string {
    return [
        'node_modules',
        'dist',
        '.env',
        '.env.*',
        'run.log',
        '.git',
        '*.log',
        // Runtime data, bind-mounted read-write by DockerRuntimeManagerService.start() - never
        // baked into the image (see the '-v ...:/app/uploads:rw' mount and its comment there).
        'uploads',
    ].join('\n') + '\n';
}