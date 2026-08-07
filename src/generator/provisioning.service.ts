import {
    Injectable,
    Logger,
    InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, escapeIdentifier, escapeLiteral } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from '../common/utils/encryption.util';
import { platformSlugToDbName, platformSlugToDbUser, generateSecurePassword } from '../common/utils/db-identifier.util';

/**
 * Interface representing the structure of the database provisioning output.
 */
interface ProvisionResult {
    host: string;
    port: number;
    databaseName: string;
    databaseUser: string;
    databaseUrl: string;
}

/**
 * Service responsible for multi-tenant database provisioning and lifecycle management.
 * * Handles dynamically creating dedicated PostgreSQL databases and user roles,
 * securing credentials, preventing race conditions using PostgreSQL advisory locks,
 * and maintaining metadata records within the primary system database.
 */
@Injectable()
export class ProvisioningService {

    private readonly logger = new Logger(ProvisioningService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    /**
     * Dynamically provisions a isolated PostgreSQL database and user role for a platform tenant.
     * * @param platformId - The unique identifier of the target platform/tenant.
     * @param slug - The platform's unique human-readable slug (used to derive DB names).
     * @returns The newly created or existing database configuration and decrypted connection string.
     * * @throws InternalServerErrorException - If provisioning or database record creation fails.
     */
    async provisionDatabaseForPlatform(
        platformId: string,
        slug: string,
    ): Promise<ProvisionResult> {
        // 1. Derive sanitized PostgreSQL database and role names from the tenant slug.
        const dbName = platformSlugToDbName(slug);
        const dbUser = platformSlugToDbUser(slug);

        // Fetch infrastructure parameters from configuration with fallback defaults.
        const host = this.configService.get<string>(
            'database.provisioningHost',
            'localhost',
        );

        const port = this.configService.get<number>(
            'database.provisioningPort',
            5432,
        );

        const encryptionKey = this.configService.getOrThrow<string>('security.encryptionKey');
        const serverName = this.configService.getOrThrow<string>('app.serverName');

        /*
         * 2. First Idempotency Check (Fast-path):
         * Check if this platform already has an active database record in BackOS.
         * If present, return the existing connection settings immediately without contacting Postgres.
         */
        const existingDatabase = await this.prisma.platformDatabase.findUnique({
            where: { platformId },
        });

        if (existingDatabase) {
            const databaseUrl = await this.getDecryptedConnectionUrl(platformId);

            return {
                host: existingDatabase.host,
                port: existingDatabase.port,
                databaseName: existingDatabase.databaseName,
                databaseUser: existingDatabase.databaseUser,
                databaseUrl,
            };
        }

        // Generate a random high-entropy password for the new database user.
        const password = generateSecurePassword();
        
        // Initialize direct raw `pg` client connected via administrative credentials.
        const adminClient = this.getAdminClient();
        await adminClient.connect();

        /*
         * 3. Concurrency Protection via PostgreSQL Distributed Advisory Locks:
         * Prevents race conditions where two simultaneous API requests/workers attempt
         * to provision a database for the exact same platform concurrently.
         */
        const lockKey = `${serverName}:provision:${platformId}`;

        try {
            // Acquire an exclusive session-level advisory lock using string hash.
            await adminClient.query(
                `SELECT pg_advisory_lock(hashtext($1))`,
                [lockKey],
            );

            /*
             * 4. Second Idempotency Check (Double-Checked Locking Pattern):
             * Re-verify database existence after obtaining the lock.
             * Another concurrent worker might have completed the provisioning process 
             * while this request was waiting to acquire the advisory lock.
             */
            const databaseAfterLock =
                await this.prisma.platformDatabase.findUnique({
                    where: { platformId },
                });

            if (databaseAfterLock) {
                const databaseUrl = await this.getDecryptedConnectionUrl(platformId);

                return {
                    host: databaseAfterLock.host,
                    port: databaseAfterLock.port,
                    databaseName: databaseAfterLock.databaseName,
                    databaseUser: databaseAfterLock.databaseUser,
                    databaseUrl,
                };
            }

            /*
             * 5. SQL Injection Prevention:
             * Data Definition Language (DDL) statements like CREATE ROLE and CREATE DATABASE 
             * do NOT support standard parameterized placeholders ($1, $2).
             * We MUST explicitly sanitize identifiers and string literals using `pg` utilities.
             */
            const roleIdentifier = escapeIdentifier(dbUser);
            const databaseIdentifier = escapeIdentifier(dbName);
            const passwordLiteral = escapeLiteral(password);
            const provisionRole = escapeIdentifier(
                this.configService.getOrThrow<string>(
                    'database.provisioningRole',
                ),
            );

            /*
             * 6. Check Role Existence:
             * Query system catalog `pg_roles` to verify if the role already exists.
             */
            const roleResult = await adminClient.query(
                `
                SELECT 1
                FROM pg_roles
                WHERE rolname = $1
                `,
                [dbUser],
            );

            const roleExists = roleResult.rowCount === 1;

            /*
             * 7. Role Provisioning / Credentials Sync:
             * Create the role with login permissions if missing.
             * If it already exists, update its password to stay aligned with the new token.
             */
            if (!roleExists) {
                await adminClient.query(
                    `
                    CREATE ROLE ${roleIdentifier}
                    WITH LOGIN PASSWORD ${passwordLiteral}
                    `,
                );
            } else {
                await adminClient.query(
                    `
                    ALTER ROLE ${roleIdentifier}
                    WITH LOGIN PASSWORD ${passwordLiteral}
                    `,
                );
            }

            /*
             * 8. Check Database Existence:
             * Query system catalog `pg_database` to verify database status and its owner.
             */
            const databaseResult = await adminClient.query(
                `
                SELECT
                    datname,
                    pg_get_userbyid(datdba) AS owner
                FROM pg_database
                WHERE datname = $1
                `,
                [dbName],
            );

            const databaseExists = databaseResult.rowCount === 1;

            if (!databaseExists) {

                /*
                 * PostgreSQL Permission Constraint Workaround:
                 * In PostgreSQL, to assign a new role as the `OWNER` during `CREATE DATABASE`,
                 * the executing superuser/provisioning role must temporarily be a member of that target role.
                 */
                await adminClient.query(
                    `
                    GRANT ${roleIdentifier}
                    TO ${provisionRole}
                    `,
                );

                try {
                    // Create the database setting the tenant user as the official owner.
                    await adminClient.query(
                        `
                        CREATE DATABASE ${databaseIdentifier}
                        OWNER ${roleIdentifier}
                        `,
                    );
                } finally {
                    /*
                     * Principle of Least Privilege:
                     * Always immediately revoke the temporary role grant, even if database creation fails.
                     */
                    await adminClient.query(
                        `
                        REVOKE ${roleIdentifier}
                        FROM ${provisionRole}
                        `,
                    );
                }

            } else {

                const existingOwner = databaseResult.rows[0].owner;

                /*
                 * Safety Assertion:
                 * Refuse silently acquiring ownership if an existing database belongs to a different role.
                 */
                if (existingOwner !== dbUser) {
                    throw new Error(
                        `Database "${dbName}" already exists but belongs to owner "${existingOwner}".`,
                    );
                }
            }

            /*
             * 9. Security Hardening:
             * Revoke default `PUBLIC` connection and creation permissions from the new database.
             * This prevents unauthorized non-owner database users from creating tables or inspecting schema.
             */
            await adminClient.query(
                `
                REVOKE ALL
                ON DATABASE ${databaseIdentifier}
                FROM PUBLIC
                `,
            );

        } catch (error) {

            this.logger.error(
                `Provisioning failed for tenant slug "${slug}"`,
                error instanceof Error ? error.stack : String(error),
            );

            /*
             * Rollback Cleanup:
             * Attempt to remove partially created database objects (database and user role).
             */
            await this.safeCleanup(
                adminClient,
                dbName,
                dbUser,
            );

            throw new InternalServerErrorException(
                'Failed to provision tenant database infrastructure.',
            );

        } finally {

            // Always attempt to release the PostgreSQL advisory lock.
            try {
                await adminClient.query(
                    `SELECT pg_advisory_unlock(hashtext($1))`,
                    [lockKey],
                );
            } catch (unlockError) {
                this.logger.warn(
                    `Failed to release provisioning advisory lock for platform "${platformId}".`,
                );
            }

            // Close administrative PostgreSQL connection client.
            await adminClient.end();
        }

        /*
         * 10. Metadata Record Registration:
         * Store database parameters and AES-encrypted password in the system central database via Prisma.
         */
        try {

            await this.prisma.platformDatabase.create({
                data: {
                    platformId,
                    host,
                    port,
                    databaseName: dbName,
                    databaseUser: dbUser,
                    encryptedPassword: encrypt(
                        password,
                        encryptionKey,
                    ),
                },
            });

        } catch (error) {

            /*
             * Compensating Transaction:
             * If metadata registration fails after successful PostgreSQL database creation,
             * purge the orphan PostgreSQL database and role to maintain state consistency across systems.
             */
            this.logger.error(
                `Database "${dbName}" was created successfully, but BackOS metadata registration failed. Cleaning up...`,
                error instanceof Error ? error.stack : String(error),
            );

            const cleanupClient = this.getAdminClient();

            try {
                await cleanupClient.connect();

                await this.safeCleanup(
                    cleanupClient,
                    dbName,
                    dbUser,
                );

            } finally {
                await cleanupClient.end();
            }

            throw new InternalServerErrorException(
                'Database was provisioned, but metadata record creation failed.',
            );
        }

        // Return provision result with formatted full connection string.
        return {
            host,
            port,
            databaseName: dbName,
            databaseUser: dbUser,
            databaseUrl: this.buildDatabaseUrl(
                host,
                port,
                dbName,
                dbUser,
                password,
            ),
        };
    }

    /**
     * Retrieves stored database configuration for a tenant and decrypts its credentials 
     * to reconstruct a valid PostgreSQL connection string URL.
     * * @param platformId - The unique target platform ID.
     * @returns Decrypted connection string URL.
     */
    async getDecryptedConnectionUrl(
        platformId: string,
    ): Promise<string> {

        const record =
            await this.prisma.platformDatabase.findUniqueOrThrow({
                where: { platformId },
            });

        const encryptionKey =
            this.configService.getOrThrow<string>('ENCRYPTION_KEY');

        // Decrypt password stored in database metadata.
        const password = decrypt(
            record.encryptedPassword,
            encryptionKey,
        );

        return this.buildDatabaseUrl(
            record.host,
            record.port,
            record.databaseName,
            record.databaseUser,
            password,
        );
    }

    /**
     * Deprovisions and permanently deletes a platform tenant database, role, 
     * and metadata record from BackOS.
     * * @param platformId - The unique platform identifier to purge.
     */
    async deprovisionDatabaseForPlatform(
        platformId: string,
    ): Promise<void> {

        const record =
            await this.prisma.platformDatabase.findUnique({
                where: { platformId },
            });

        // Exit gracefully if no registered platform database exists.
        if (!record) return;

        const adminClient = this.getAdminClient();

        await adminClient.connect();

        try {
            // Drop target database and role safely.
            await this.safeCleanup(
                adminClient,
                record.databaseName,
                record.databaseUser,
            );

        } finally {
            await adminClient.end();
        }

        // Remove platform metadata record from BackOS central system.
        await this.prisma.platformDatabase.delete({
            where: { platformId },
        });
    }

    /**
     * Helper method to safely drop a database and role without crashing overall execution.
     * Terminate active client backends before dropping to prevent "database in use" errors.
     * * @param adminClient - Active administrative `pg` connection client.
     * @param dbName - Target database name to drop.
     * @param dbUser - Target role/user to drop.
     */
    private async safeCleanup(
        adminClient: Client,
        dbName: string,
        dbUser: string,
    ): Promise<void> {

        const databaseIdentifier = escapeIdentifier(dbName);
        const roleIdentifier = escapeIdentifier(dbUser);

        try {

            /*
             * Forcefully terminate active backend connections to the target database.
             * PostgreSQL will reject `DROP DATABASE` statements if any active connections exist.
             */
            await adminClient.query(
                `
                SELECT pg_terminate_backend(pid)
                FROM pg_stat_activity
                WHERE datname = $1
                  AND pid <> pg_backend_pid()
                `,
                [dbName],
            );

            // Drop database and user role idempotently.
            await adminClient.query(
                `DROP DATABASE IF EXISTS ${databaseIdentifier}`,
            );

            await adminClient.query(
                `DROP ROLE IF EXISTS ${roleIdentifier}`,
            );

        } catch (cleanupError) {

            this.logger.error(
                `Partial cleanup failed for database "${dbName}" / user "${dbUser}"`,
                cleanupError instanceof Error
                    ? cleanupError.stack
                    : String(cleanupError),
            );
        }
    }

    /**
     * Formats database parameters into a URL-encoded URI string.
     * Ensures special characters in passwords and usernames are properly escaped.
     */
    private buildDatabaseUrl(
        host: string,
        port: number,
        databaseName: string,
        databaseUser: string,
        password: string,
    ): string {

        return (
            `postgresql://${encodeURIComponent(databaseUser)}` +
            `:${encodeURIComponent(password)}` +
            `@${host}:${port}/${encodeURIComponent(databaseName)}` +
            `?schema=public`
        );
    }

    /**
     * Instantiates a low-level Node-Postgres (`pg`) Client using administrative privileges 
     * defined in configuration environment variables.
     */
    private getAdminClient(): Client {

        const connectionString =
            this.configService.getOrThrow<string>(
                'database.provisioningUrl',
            );

        return new Client({
            connectionString,
        });
    }
}