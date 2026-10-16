import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
    PLATFORM_PERMISSIONS,
    PLATFORM_PERMISSION_DESCRIPTIONS,
} from '../common/constants/platform-permissions.constant';

/**
 * Keeps the `PlatformPermission` catalog in sync with the `PLATFORM_PERMISSIONS` code constant at
 * boot - the platform-scoped counterpart of `PermissionsSyncService`. See that class's doc
 * comment; the same idempotent upsert + stale-row purge logic applies here, just against
 * `PlatformPermission` instead of `Permission`.
 */
@Injectable()
export class PlatformPermissionsSyncService implements OnApplicationBootstrap {
    private readonly logger = new Logger(PlatformPermissionsSyncService.name);

    constructor(private readonly prisma: PrismaService) {}

    async onApplicationBootstrap() {
        const keys = Object.values(PLATFORM_PERMISSIONS);

        for (const key of keys) {
            await this.prisma.platformPermission.upsert({
                where: { key },
                update: { description: PLATFORM_PERMISSION_DESCRIPTIONS[key] },
                create: { key, description: PLATFORM_PERMISSION_DESCRIPTIONS[key] },
            });
        }

        // Same rationale as PermissionsSyncService: a key removed from the code constant during a
        // refactor must stop being grantable. PlatformRolePermission.platformPermissionId cascades
        // on delete, so this also cleanly retracts the stale permission from any custom role that
        // still (incorrectly) held it.
        const deleted = await this.prisma.platformPermission.deleteMany({
            where: { key: { notIn: keys } },
        });

        if (deleted.count > 0) {
            this.logger.warn(
                `Platform permission catalog purge: removed ${deleted.count} stale permission(s) no ` +
                    `longer defined in code (and revoked them from any platform role that still held them).`,
            );
        }

        this.logger.log(`Platform permission catalog successfully synchronized (${keys.length} permissions).`);
    }
}
