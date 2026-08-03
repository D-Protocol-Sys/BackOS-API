import { Injectable, Logger, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { PrismaService } from '../prisma/prisma.service';
import { encrypt, decrypt } from '../common/utils/encryption.util';
import {
    platformSlugToDbName,
    platformSlugToDbUser,
    generateSecurePassword,
} from '../common/utils/db-identifier.util';

interface ProvisionResult {
    host: string;
    port: number;
    databaseName: string;
    databaseUser: string;
    databaseUrl: string;
}

@Injectable()
export class ProvisioningService {

    private readonly logger = new Logger(ProvisioningService.name);

    constructor(
        private readonly prisma: PrismaService,
        private readonly configService: ConfigService,
    ) {}

    async provisionDatabaseForPlatform(platformId: string, slug: string): Promise<ProvisionResult> {
        const dbName = platformSlugToDbName(slug);
        const dbUser = platformSlugToDbUser(slug);
        const password = generateSecurePassword();

        const adminClient = this.getAdminClient();
        await adminClient.connect();

        try {
            await adminClient.query(`CREATE ROLE "${dbUser}" WITH LOGIN PASSWORD '${password}'`);
            await adminClient.query(`CREATE DATABASE "${dbName}" OWNER "${dbUser}"`);
            await adminClient.query(`REVOKE ALL ON DATABASE "${dbName}" FROM PUBLIC`);
        } catch (error) {
            this.logger.error(`Échec du provisioning pour "${slug}"`, error);
            await this.safeCleanup(adminClient, dbName, dbUser);
            throw new InternalServerErrorException('Échec de la création de la base de données.');
        } finally {
            await adminClient.end();
        }

        const host = this.configService.get<string>('DB_PROVISION_HOST', 'localhost');
        const port = this.configService.get<number>('DB_PROVISION_PORT', 5432);
        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');

        await this.prisma.platformDatabase.create({
            data: {
                platformId,
                host,
                port,
                databaseName: dbName,
                databaseUser: dbUser,
                encryptedPassword: encrypt(password, encryptionKey),
            },
        });

        return {
            host,
            port,
            databaseName: dbName,
            databaseUser: dbUser,
            databaseUrl: `postgresql://${dbUser}:${password}@${host}:${port}/${dbName}?schema=public`,
        };
    }

    async getDecryptedConnectionUrl(platformId: string): Promise<string> {
        const record = await this.prisma.platformDatabase.findUniqueOrThrow({
            where: { platformId },
        });
        const encryptionKey = this.configService.getOrThrow<string>('ENCRYPTION_KEY');
        const password = decrypt(record.encryptedPassword, encryptionKey);

        return `postgresql://${record.databaseUser}:${password}@${record.host}:${record.port}/${record.databaseName}?schema=public`;
    }

    async deprovisionDatabaseForPlatform(platformId: string): Promise<void> {
        const record = await this.prisma.platformDatabase.findUnique({ where: { platformId } });
        if (!record) return;

        const adminClient = this.getAdminClient();
        await adminClient.connect();
        try {
            await this.safeCleanup(adminClient, record.databaseName, record.databaseUser);
        } finally {
            await adminClient.end();
        }

        await this.prisma.platformDatabase.delete({ where: { platformId } });
    }

    private async safeCleanup(adminClient: Client, dbName: string, dbUser: string) {
        try {
        await adminClient.query(
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
            [dbName],
        );
        await adminClient.query(`DROP DATABASE IF EXISTS "${dbName}"`);
        await adminClient.query(`DROP ROLE IF EXISTS "${dbUser}"`);
        } catch (cleanupError) {
            this.logger.error(`Nettoyage partiel échoué pour "${dbName}"/"${dbUser}"`, cleanupError);
        }
    }

    private getAdminClient(): Client {
        const connectionString = this.configService.getOrThrow<string>('POSTGRES_PROVISIONING_URL');
        return new Client({ connectionString });
    }
}