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

        // SECURITY FIX (audit #12 - medium): this used to only ever `upsert`, never removing a
        // permission that had been deleted from the `PERMISSIONS` constant during a refactor.
        // Those "ghost" rows had no direct authorization impact (nothing looks them up
        // dynamically by key outside this sync), but they accumulate silently and make a future
        // manual audit of the `permissions` table misleading - a stale row can look like a live,
        // grantable permission. `RolePermission.permissionId` cascades on delete (see
        // `schema.prisma`), so removing a stale `Permission` also cleanly retracts it from any
        // role that still (incorrectly) referenced it - which is the correct outcome for a
        // permission key that no longer exists in code.
        const deleted = await this.prisma.permission.deleteMany({
            where: { key: { notIn: keys } },
        });

        if (deleted.count > 0) {
            this.logger.warn(
                `Permission catalog purge: removed ${deleted.count} stale permission(s) no ` +
                `longer defined in code (and revoked them from any role that still held them).`,
            );
        }

        this.logger.log(`Permission catalog successfully synchronized (${keys.length} permissions).`);
    
    }
    
}