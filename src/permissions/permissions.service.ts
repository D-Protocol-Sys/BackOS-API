import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Service providing read access to the application permissions catalog.
 * Acts as the data retrieval layer for managing user roles, access control management,
 * and security policy configurations.
 */
@Injectable()
export class PermissionsService {
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Retrieves all available permissions registered in the database,
     * ordered alphabetically by their unique key.
     * * @returns Promise resolving to the complete array of `Permission` records.
     */
    async listAll() {
        return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
    }
}
