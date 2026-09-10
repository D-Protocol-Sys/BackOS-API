import { Injectable, Logger, InternalServerErrorException, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import * as zlib from 'zlib';
import { pipeline } from 'stream/promises';
import { runCommand, CommandFailedError } from '../common/utils/command-runner.util';
import { PrismaService } from '../prisma/prisma.service';
import { ProvisioningService } from '../generator/provisioning.service';

export interface DatabaseDumpResult {
    /** Absolute path to the finished, gzip-compressed `.sql.gz` dump file on disk. */
    filePath: string;
    /** Suggested filename for a `Content-Disposition` download response. */
    fileName: string;
    sizeBytes: number;
    createdAt: Date;
}

/**
 * Exports ("dumps") PostgreSQL databases to a plain-SQL, gzip-compressed file - both the
 * orchestrator's own database and any individual generated platform's database.
 *
 * WHY THIS EXISTS: moving to new infrastructure (a new host, a new managed Postgres instance,
 * switching to the Docker-isolated runtime, ...) is exactly the situation where you need a
 * portable, restorable copy of every database this system owns - see the conversation that led
 * here. A plain-SQL dump (`pg_dump` with no `-F c`/custom format) is deliberately chosen over
 * Postgres's binary/custom dump format: it is restorable with nothing more than `psql` on
 * virtually any Postgres version, is human-readable/diffable, and doesn't require the exact
 * same major Postgres version or `pg_restore` on the destination.
 *
 * WHAT THIS DOES NOT DO (by design, to keep scope contained): it does not schedule or retain
 * backups automatically, and it does not touch `prisma/migrations/` on disk. If you're moving
 * infrastructure, take a dump of every platform's data via this service AND copy each
 * platform's `generated/<slug>/backend/prisma/migrations/` folder (or better: commit it to
 * version control - see the conversation about migrations not being versioned). A dump restores
 * DATA; the migrations folder is what lets Prisma correctly manage the SCHEMA going forward on
 * the new infrastructure.
 */
@Injectable()
export class BackupService {
    private readonly logger = new Logger(BackupService.name);

    constructor(
        private readonly configService: ConfigService,
        private readonly prisma: PrismaService,
        private readonly provisioningService: ProvisioningService,
    ) {}

    /**
     * Dumps the orchestrator's own database (`database.url` - holds every user, platform,
     * permission, generation record, etc. this whole system knows about).
     */
    async dumpOrchestratorDatabase(): Promise<DatabaseDumpResult> {
        const url = this.configService.getOrThrow<string>('database.url');
        return this.runDump(url, 'orchestrator');
    }

    /**
     * Dumps a single generated platform's own isolated database, by platform ID.
     * Reuses `ProvisioningService.getDecryptedConnectionUrl()` - the same credentials
     * the generated backend itself connects with - so this never needs its own copy of the
     * decryption logic.
     */
    async dumpPlatformDatabase(platformId: string): Promise<DatabaseDumpResult> {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) {
            throw new NotFoundException('Platform not found.');
        }

        const url = await this.provisioningService.getDecryptedConnectionUrl(platformId);
        return this.runDump(url, platform.slug);
    }

    /**
     * Dumps every provisioned platform database, one at a time (deliberately sequential, not
     * `Promise.all` - `pg_dump` is I/O and CPU heavy, and running every platform's dump
     * concurrently is exactly the kind of host resource spike a one-off admin export shouldn't
     * risk causing on a live system). One platform's dump failing does not stop the others -
     * failures are collected and returned alongside the successes so the caller can retry just
     * what actually failed.
     */
    async dumpAllPlatformDatabases(): Promise<{
        succeeded: DatabaseDumpResult[];
        failed: Array<{ platformId: string; slug: string; error: string }>;
    }> {
        // Queries `platformDatabase` directly (not `platform` with an `include`/relation
        // filter) - this is the one model this service can be certain has a `platformId`
        // field, without guessing the name of a reverse relation field on `Platform` that
        // isn't referenced anywhere else in this codebase.
        const provisionedDatabases = await this.prisma.platformDatabase.findMany({
            select: { platformId: true },
        });

        const succeeded: DatabaseDumpResult[] = [];
        const failed: Array<{ platformId: string; slug: string; error: string }> = [];

        for (const { platformId } of provisionedDatabases) {
            const platform = await this.prisma.platform.findUnique({
                where: { id: platformId },
                select: { slug: true },
            });
            const slug = platform?.slug ?? platformId;

            try {
                succeeded.push(await this.dumpPlatformDatabase(platformId));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.logger.error(`Dump failed for platform "${slug}" (${platformId}): ${message}`);
                failed.push({ platformId, slug, error: message });
            }
        }

        return { succeeded, failed };
    }

    /**
     * SECURITY FIX (audit #6 - elevated): resolves a bare dump filename (as returned by
     * `dumpAllPlatformDatabases()`) to its absolute path on disk, for use by the new
     * `GET /backup/download` route.
     *
     * `dumpAllPlatformDatabases()` deliberately returns only `fileName` in its JSON response
     * now (not the absolute server-side `filePath`) - not just to avoid leaking the server's
     * filesystem layout, but because it lets this method safely re-derive and validate the path
     * itself instead of trusting a client-supplied absolute path. The resolved path is checked
     * to stay strictly inside `BACKUP_OUTPUT_DIR` (defeats `../` traversal or an absolute-path
     * override smuggled into `fileName`), and to look like a dump this service would actually
     * have produced (`.sql.gz` suffix) - so this can't be turned into an arbitrary-file-read
     * primitive off the back of the download route.
     *
     * @param fileName - Bare filename (no directory components), e.g. as returned by
     *   `dumpAllPlatformDatabases()`.
     * @throws BadRequestException if `fileName` is not a plausible dump filename.
     * @throws NotFoundException if the resolved file does not exist on disk.
     */
    resolveDumpPath(fileName: string): string {
        // Reject anything containing a path separator outright - a bare filename should never
        // need one, and this is the cheapest way to stop `../../etc/passwd`-style traversal
        // before path.join/resolve ever gets a chance to normalize it away.
        if (
            !fileName ||
            fileName.includes('/') ||
            fileName.includes('\\') ||
            !/^[a-zA-Z0-9-_]+\.sql\.gz$/.test(fileName)
        ) {
            throw new BadRequestException('Invalid dump file name.');
        }

        const outputDir = this.resolveOutputDir();
        const resolvedPath = path.resolve(outputDir, fileName);

        // Defense in depth: even though the filename pattern above already rules out
        // traversal, re-verify the resolved absolute path is still contained within the
        // configured output directory before ever touching the filesystem with it.
        const relative = path.relative(outputDir, resolvedPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            throw new BadRequestException('Invalid dump file name.');
        }

        if (!fs.existsSync(resolvedPath)) {
            throw new NotFoundException('Dump file not found (it may have already been downloaded, or purged by retention cleanup).');
        }

        return resolvedPath;
    }

    /**
     * Deletes a dump file from disk. Callers are expected to clean up after streaming a dump
     * back to the client - dumps are exports, not a retained backup archive (see the
     * class-level comment for why automatic retention/scheduling is out of scope here).
     */
    async deleteDump(filePath: string): Promise<void> {
        try {
            await fsp.unlink(filePath);
        } catch (error) {
            // Not fatal - a leftover temp file is a disk-space nuisance, not a correctness bug.
            this.logger.warn(`Failed to remove temporary dump file "${filePath}": ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // ---- Internals ----

    private async runDump(connectionUrl: string, label: string): Promise<DatabaseDumpResult> {
        const outputDir = this.resolveOutputDir();
        await fsp.mkdir(outputDir, { recursive: true });

        const timestamp = this.formatTimestamp(new Date());
        const safeLabel = this.sanitizeLabel(label);
        const rawSqlPath = path.join(outputDir, `${safeLabel}_${timestamp}.sql`);
        const gzPath = `${rawSqlPath}.gz`;
        const timeoutMs = this.configService.get<number>('BACKUP_TIMEOUT_MS', 10 * 60 * 1000);

        try {
            // Plain-text SQL dump - see the class-level comment for why this format was chosen
            // over pg_dump's custom/binary format. `--no-owner --no-privileges` strips
            // GRANT/OWNER statements tied to this environment's specific role names, which
            // would otherwise fail to restore on a fresh destination that doesn't have those
            // exact roles yet - exactly the "moving to new infra" scenario this exists for.
            await runCommand(
                'pg_dump',
                [
                    `--dbname=${this.toLibpqConnectionUrl(connectionUrl)}`,
                    '--no-owner',
                    '--no-privileges',
                    '--verbose',
                    '--file', rawSqlPath,
                ],
                outputDir,
                timeoutMs,
            );
        } catch (error) {
            if (error instanceof CommandFailedError) {
                this.logger.error(`pg_dump failed for "${label}": ${error.message}`);
                throw new InternalServerErrorException(
                    `Database export failed for "${label}". Make sure the "pg_dump" client tool ` +
                    `(matching your Postgres server's major version) is installed and on PATH.`,
                );
            }
            throw error;
        }

        await this.gzip(rawSqlPath, gzPath);
        await fsp.unlink(rawSqlPath);

        const stats = await fsp.stat(gzPath);
        return {
            filePath: gzPath,
            fileName: path.basename(gzPath),
            sizeBytes: stats.size,
            createdAt: stats.birthtime,
        };
    }

    private async gzip(sourcePath: string, destPath: string): Promise<void> {
        await pipeline(
            fs.createReadStream(sourcePath),
            zlib.createGzip({ level: 6 }),
            fs.createWriteStream(destPath),
        );
    }

    private resolveOutputDir(): string {
        const configured = this.configService.get<string>('BACKUP_OUTPUT_DIR', 'backups');
        return path.isAbsolute(configured) ? configured : path.resolve(process.cwd(), configured);
    }

    /**
     * BUGFIX (found in production, 2026-09-10): `ProvisioningService.getDecryptedConnectionUrl()`
     * builds Prisma-style connection URLs, e.g.
     * `postgresql://user:pass@host:5432/db?schema=public` - the `?schema=` query parameter is a
     * Prisma-specific extension, not a standard libpq connection parameter. `pg_dump` (which
     * uses libpq's own URI parser, not Prisma's) rejects it outright: `pg_dump: erreur :
     * paramètre de la requête URI invalide : « schema »`. Strips that parameter before handing
     * the URL to `pg_dump` - Prisma-facing code paths are untouched, since Prisma needs it.
     */
    private toLibpqConnectionUrl(prismaStyleUrl: string): string {
        const url = new URL(prismaStyleUrl);
        url.searchParams.delete('schema');
        return url.toString();
    }

    /** `YYYYMMDD-HHmmss`, filesystem- and URL-safe, sorts chronologically by filename. */
    private formatTimestamp(date: Date): string {
        return date.toISOString().replace(/[:T]/g, '-').split('.')[0];
    }

    /** Keeps generated filenames predictable and free of path-traversal or shell-hostile characters. */
    private sanitizeLabel(label: string): string {
        return label.replace(/[^a-zA-Z0-9-_]/g, '-');
    }
}
