import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Interface mapping PostgreSQL `pg_roles` system catalog attributes 
 * required for database provisioning capabilities.
 */
interface ProvisioningRoleState {
    rolname: string;
    rolcanlogin: boolean;
    rolcreatedb: boolean;
    rolcreaterole: boolean;
}

/**
 * Service that implements `OnModuleInit` to perform boot-time health checks on the database.
 * Verifies that the designated PostgreSQL provisioning role exists and possesses required system privileges.
 */
@Injectable()
export class ProvisioningHealthService implements OnModuleInit {
    private readonly logger = new Logger(
        ProvisioningHealthService.name,
    );

    constructor(
        private readonly prisma: PrismaService,
    ) {}

    /**
     * NestJS Lifecycle Hook executing automatically during application startup.
     * Ensures database role capabilities before accepting incoming requests.
     */
    async onModuleInit(): Promise<void> {
        await this.verifyProvisioningRole();
    }

    /**
     * Queries PostgreSQL system catalog (`pg_roles`) to validate that the configured
     * provisioning user exists and holds LOGIN, CREATEDB, and CREATEROLE permissions.
     */
    private async verifyProvisioningRole(): Promise<void> {
        const roleName = process.env.POSTGRES_PROVISIONING_ROLE;

        if (!roleName) {
            throw new Error(
                'POSTGRES_PROVISIONING_ROLE is not configured.',
            );
        }

        this.logger.log(
            `Checking PostgreSQL provisioning role "${roleName}"...`,
        );

        // Query the PostgreSQL catalog directly for role attributes
        const result = await this.prisma.$queryRaw<ProvisioningRoleState[]>`
            SELECT
            rolname,
            rolcanlogin,
            rolcreatedb,
            rolcreaterole
            FROM pg_roles
            WHERE rolname = ${roleName};
        `;

        if (result.length === 0) {
            this.logger.error(
                `CRITICAL: PostgreSQL provisioning role "${roleName}" does not exist.`,
            );

            throw new Error(
                `Required PostgreSQL provisioning role "${roleName}" does not exist.`,
            );
        }

        const role = result[0];

        // Assert that the role possesses all required administrative capabilities
        const valid =
            role.rolcanlogin === true &&
            role.rolcreatedb === true &&
            role.rolcreaterole === true;

        if (!valid) {
            this.logger.error(
                `CRITICAL: PostgreSQL provisioning role "${roleName}" has invalid privileges.`,
            );

            throw new Error(
                `PostgreSQL provisioning role "${roleName}" does not have the required privileges.`,
            );
        }

        this.logger.log(
            `PostgreSQL provisioning role "${roleName}" is valid.`,
        );
    }
}