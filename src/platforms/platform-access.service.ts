import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
    PLATFORM_ADMIN_IMPLICIT_PERMISSIONS,
    PLATFORM_PERMISSIONS,
    PlatformPermissionKey,
} from '../common/constants/platform-permissions.constant';

/**
 * Requesting actor: their BackOS user id and their global (orchestrator-wide) permissions - the
 * same shape used everywhere else (`PlatformsController`, `GeneratorController`, ...).
 */
export type Actor = { userId: string; permissions: string[] };

export type PlatformLike = { id: string; ownerId: string };

/**
 * Single source of truth for "what can this actor do on this platform", now that platform roles
 * are free-form rows instead of a fixed `VIEWER | EDITOR | ADMIN` enum. Used by `PlatformsService`
 * (member/role management), `PlatformRolesService` (the permission-ceiling rule on role
 * creation), `GeneratorController` (who can trigger/approve a generation) and `UsersService`
 * (the GDPR export access rule) - kept in its own module (`PlatformAccessModule`) with no
 * dependency on `GeneratorModule`/`PlatformsModule` so all of them can import it without a
 * circular dependency.
 */
@Injectable()
export class PlatformAccessService {

    constructor(private readonly prisma: PrismaService) {}

    /**
     * The actor's membership + role on this platform, or `null` if they are not a member (the
     * owner is never a "member" row - callers check `platform.ownerId === actor.userId`
     * separately, exactly like the rest of the codebase already does).
     */
    private async getMembership(userId: string, platformId: string) {
        return this.prisma.platformMember.findUnique({
            where: { platformId_userId: { platformId, userId } },
            include: { platformRole: { include: { rolePermissions: { include: { platformPermission: true } } } } },
        });
    }

    /**
     * Resolves the actor's effective platform-scoped permission set:
     * - the owner implicitly holds every grantable permission (see the catalog's doc comment for
     *   what's deliberately excluded even for the owner - delete/transfer/purge are separate,
     *   owner-only checks, never part of this set);
     * - the system ADMIN role implicitly holds every grantable permission too
     *   (`PLATFORM_ADMIN_IMPLICIT_PERMISSIONS`), never read from `PlatformRolePermission` rows;
     * - any other (custom) role holds exactly the permissions stored on its row.
     */
    async getEffectivePermissions(actor: Actor, platform: PlatformLike): Promise<{
        isOwner: boolean;
        isAdmin: boolean;
        permissions: Set<PlatformPermissionKey>;
    }> {
        if (platform.ownerId === actor.userId) {
            return { isOwner: true, isAdmin: false, permissions: new Set(PLATFORM_ADMIN_IMPLICIT_PERMISSIONS) };
        }

        const membership = await this.getMembership(actor.userId, platform.id);
        if (!membership) {
            return { isOwner: false, isAdmin: false, permissions: new Set() };
        }

        if (membership.platformRole.isSystem) {
            // The system role today is always "ADMIN" (the only isSystem role seeded per
            // platform - see PlatformsService.create()).
            return { isOwner: false, isAdmin: true, permissions: new Set(PLATFORM_ADMIN_IMPLICIT_PERMISSIONS) };
        }

        const permissions = new Set(
            membership.platformRole.rolePermissions.map((rp) => rp.platformPermission.key as PlatformPermissionKey),
        );
        return { isOwner: false, isAdmin: false, permissions };
    }

    /**
     * Throws unless the actor holds `permission` on this platform (owner, ADMIN, or a custom role
     * that includes it) - or holds the equivalent *global* permission, when one is given, exactly
     * like the existing global-override pattern in `PlatformsService`/`GeneratorController`.
     */
    async assertHasPermission(
        actor: Actor,
        platform: PlatformLike,
        permission: PlatformPermissionKey,
        globalOverride?: string,
    ): Promise<void> {
        if (globalOverride && actor.permissions.includes(globalOverride)) return;

        const { permissions } = await this.getEffectivePermissions(actor, platform);
        if (!permissions.has(permission)) {
            throw new ForbiddenException('Action not authorized on this platform.');
        }
    }

    /**
     * Whether `userId` may hold an INTERNAL account on the platform's generated backend (i.e. may
     * work on its records): the owner, an ADMIN, or a member whose custom role carries at least
     * one `data.*` permission. Same rule `ProjectScaffolderService.buildInternalAccountsEnv()`
     * uses to decide who gets an account created, applied again at login time so a role that
     * lost its data permissions stops being able to authenticate there.
     */
    async hasInternalAccess(userId: string, platform: PlatformLike): Promise<boolean> {
        const { isOwner, isAdmin, permissions } = await this.getEffectivePermissions(
            { userId, permissions: [] },
            platform,
        );
        if (isOwner || isAdmin) return true;
        return [
            PLATFORM_PERMISSIONS.DATA_CREATE,
            PLATFORM_PERMISSIONS.DATA_READ,
            PLATFORM_PERMISSIONS.DATA_UPDATE,
            PLATFORM_PERMISSIONS.DATA_DELETE,
        ].some((key) => permissions.has(key));
    }

    /**
     * Everyone who currently holds an INTERNAL account on the platform's generated backend, as
     * `{ userId, username }`: the owner, every ADMIN, and every member whose custom role carries
     * at least one `data.*` permission. Only ACTIVE users. Single source of truth for BOTH the
     * `INTERNAL_ACCOUNTS` variable written at generation time and the live list the running
     * backend pulls from BackOS (see `InternalGeneratedAuthService.listInternalAccounts()`).
     */
    async listInternalAccounts(platformId: string): Promise<{ userId: string; username: string }[]> {
        const dataPermissionKeys = [
            PLATFORM_PERMISSIONS.DATA_CREATE,
            PLATFORM_PERMISSIONS.DATA_READ,
            PLATFORM_PERMISSIONS.DATA_UPDATE,
            PLATFORM_PERMISSIONS.DATA_DELETE,
        ];

        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
            select: {
                ownerId: true,
                members: {
                    where: {
                        platformRole: {
                            OR: [
                                { isSystem: true },
                                { rolePermissions: { some: { platformPermission: { key: { in: dataPermissionKeys } } } } },
                            ],
                        },
                    },
                    select: { userId: true },
                },
            },
        });
        if (!platform) return [];

        const ids = Array.from(new Set([platform.ownerId, ...platform.members.map((member) => member.userId)]));
        const users = await this.prisma.user.findMany({
            where: { id: { in: ids }, status: 'ACTIVE' },
            select: { id: true, username: true },
        });
        return users.map((user) => ({ userId: user.id, username: user.username }));
    }

}
