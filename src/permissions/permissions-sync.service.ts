import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from '../common/constants/permissions.constant';

/**
 * Service responsible for synchronizing application permissions with the database.
 * Implements `OnApplicationBootstrap` to execute permission indexing automatically 
 * when the NestJS application starts up.
 */
@Injectable()
export class PermissionsSyncService implements OnApplicationBootstrap {

    private readonly logger = new Logger(PermissionsSyncService.name);

    constructor(private readonly prisma: PrismaService) {}

    /**
     * NestJS Lifecycle Hook triggered once all application modules have initialized.
     * Iterates over all defined permission keys and performs an idempotent upsert 
     * in the database to keep the catalog up to date with code constants.
     */
    async onApplicationBootstrap() {

        const keys = Object.values(PERMISSIONS);

        // Synchronize each permission constant with the database record
        for (const key of keys) {
            await this.prisma.permission.upsert({
                where: { key },
                update: { description: PERMISSION_DESCRIPTIONS[key] },
                create: { key, description: PERMISSION_DESCRIPTIONS[key] },
            });
        }

        this.logger.log(`Permission catalog successfully synchronized (${keys.length} permissions).`);
    
    }
    
}