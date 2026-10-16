import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from '../common/constants/permissions.constant';
import { collectFeaturePermissions } from '../features/feature-registry';

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
        // OPTIONAL FEATURES: the permissions declared by EVERY installed feature are part of the
        // catalog, whether the feature is currently enabled or not. Leaving a disabled feature's
        // permissions out would make the purge below delete them, and with them every role's
        // assignment of them - which switching the feature back on could not restore.
        const featurePermissions = collectFeaturePermissions();
        const descriptions: Record<string, string> = { ...PERMISSION_DESCRIPTIONS, ...featurePermissions };
        const keys: string[] = [...Object.values(PERMISSIONS), ...Object.keys(featurePermissions)];

        // Synchronize each permission constant with the database record
        for (const key of keys) {
            await this.prisma.permission.upsert({
                where: { key },
                update: { description: descriptions[key] },
                create: { key, description: descriptions[key] },
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

        await this.syncOwnerRolePermissions();

        this.logger.log(`Permission catalog successfully synchronized (${keys.length} permissions).`);
    }

    /**
     * Keeps the built-in `owner` role holding EVERY permission of the catalog, at every boot.
     *
     * The seed only links permissions to the owner role when it is run, so a permission added to
     * `PERMISSIONS` later reached the `permissions` table (see above) but never the owner - the
     * only way to fix that used to be re-running the seed. Doing it here means the owner account
     * (and everything attached to it) is never recreated: only the missing `role_permissions`
     * rows are inserted, idempotently (`skipDuplicates`).
     *
     * Deliberately limited to the `owner` role: it is `isSystem` (cannot be edited through the
     * roles API - see `RolesService`), so "owner = all permissions" is an invariant, not a choice.
     * Other roles (admin, developer, custom ones) are configurable and are never touched here.
     * On a brand-new database the role doesn't exist yet (the seed creates it), so this is a no-op.
     */
    private async syncOwnerRolePermissions() {
        const ownerRole = await this.prisma.role.findUnique({ where: { name: 'owner' } });
        if (!ownerRole) return;

        const allPermissions = await this.prisma.permission.findMany({ select: { id: true } });

        const result = await this.prisma.rolePermission.createMany({
            data: allPermissions.map((permission) => ({ roleId: ownerRole.id, permissionId: permission.id })),
            skipDuplicates: true,
        });

        if (result.count > 0) {
            this.logger.log(`Owner role: granted ${result.count} new permission(s) automatically.`);
        }
    }
}
