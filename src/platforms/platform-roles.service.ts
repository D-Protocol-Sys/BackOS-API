import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlatformAccessService, Actor } from './platform-access.service';
import { InternalAccountsSyncService } from '../generator/internal-accounts-sync.service';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { PLATFORM_PERMISSIONS, PlatformPermissionKey } from '../common/constants/platform-permissions.constant';
import { CreatePlatformRoleDto } from './dto/create-platform-role.dto';
import { UpdatePlatformRoleDto } from './dto/update-platform-role.dto';

/**
 * Manages the custom, platform-scoped roles the owner or an ADMIN create to delegate specific
 * tasks on a platform (e.g. "Data Operator" with only the `data.*` permissions, "RH" with only
 * member/planning management). Each role is its own row, local to exactly one platform - there is
 * no cross-platform sharing, even when the same name is reused on two platforms (see
 * `PlatformRole`'s doc comment in `schema.prisma`).
 *
 * The one rule that matters everywhere in this service: nobody can grant a permission they do not
 * themselves hold on this platform (`assertGrantablePermissions()`). This is what stops an ADMIN
 * from quietly minting a role with permissions even ADMIN doesn't have, and stops privilege
 * creep in general as roles get created/edited over time.
 */
@Injectable()
export class PlatformRolesService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly access: PlatformAccessService,
        private readonly internalAccountsSync: InternalAccountsSyncService,
    ) {}

    async list(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertCanView(actor, platform);

        return this.prisma.platformRole.findMany({
            where: { platformId },
            include: { rolePermissions: { include: { platformPermission: true } } },
            orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        });
    }

    /**
     * The full platform permission catalog, each entry flagged `grantable` when the caller holds it
     * themselves - i.e. exactly what they may put in a role (the permission-ceiling rule). Lets the
     * role editor grey out what the caller cannot grant instead of failing on submit.
     */
    async catalog(actor: Actor, platformId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.assertCanView(actor, platform);

        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        const rows = await this.prisma.platformPermission.findMany({ orderBy: { key: 'asc' } });
        return rows.map((row) => ({
            key: row.key,
            description: row.description,
            grantable: permissions.has(row.key as PlatformPermissionKey),
        }));
    }

    async create(actor: Actor, platformId: string, dto: CreatePlatformRoleDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.access.assertHasPermission(actor, platform, PLATFORM_PERMISSIONS.PLATFORM_MANAGE_ROLES, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);
        await this.assertGrantablePermissions(actor, platform, dto.permissions);

        const nameTaken = await this.prisma.platformRole.findUnique({
            where: { platformId_name: { platformId, name: dto.name } },
        });
        if (nameTaken) {
            throw new ConflictException(`A role named "${dto.name}" already exists on this platform.`);
        }

        return this.prisma.platformRole.create({
            data: {
                platformId,
                name: dto.name,
                isSystem: false,
                rolePermissions: {
                    create: await this.resolvePermissionIds(dto.permissions),
                },
            },
            include: { rolePermissions: { include: { platformPermission: true } } },
        });
    }

    async update(actor: Actor, platformId: string, roleId: string, dto: UpdatePlatformRoleDto) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.access.assertHasPermission(actor, platform, PLATFORM_PERMISSIONS.PLATFORM_MANAGE_ROLES, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        const role = await this.findRoleOrThrow(platformId, roleId);
        if (role.isSystem) {
            throw new ForbiddenException('The system ADMIN role cannot be modified.');
        }

        if (dto.permissions) {
            await this.assertGrantablePermissions(actor, platform, dto.permissions);
        }

        if (dto.name && dto.name !== role.name) {
            const nameTaken = await this.prisma.platformRole.findUnique({
                where: { platformId_name: { platformId, name: dto.name } },
            });
            if (nameTaken) {
                throw new ConflictException(`A role named "${dto.name}" already exists on this platform.`);
            }
        }

        const updated = await this.prisma.$transaction(async (tx) => {
            if (dto.permissions) {
                await tx.platformRolePermission.deleteMany({ where: { platformRoleId: roleId } });
            }

            return tx.platformRole.update({
                where: { id: roleId },
                data: {
                    ...(dto.name ? { name: dto.name } : {}),
                    ...(dto.permissions
                        ? { rolePermissions: { create: await this.resolvePermissionIds(dto.permissions) } }
                        : {}),
                },
                include: { rolePermissions: { include: { platformPermission: true } } },
            });
        });

        // Adding or dropping `data.*` permissions on a role changes which of its holders are
        // entitled to an internal account on the generated backend - apply it immediately.
        if (dto.permissions) {
            void this.internalAccountsSync.notify(platformId);
        }
        return updated;
    }

    async remove(actor: Actor, platformId: string, roleId: string) {
        const platform = await this.findPlatformOrThrow(platformId);
        await this.access.assertHasPermission(actor, platform, PLATFORM_PERMISSIONS.PLATFORM_MANAGE_ROLES, PERMISSIONS.PLATFORM_MANAGE_MEMBERS);

        const role = await this.findRoleOrThrow(platformId, roleId);
        if (role.isSystem) {
            throw new ForbiddenException('The system ADMIN role cannot be deleted.');
        }

        const memberCount = await this.prisma.platformMember.count({ where: { platformRoleId: roleId } });
        if (memberCount > 0) {
            throw new ConflictException(
                `${memberCount} member(s) still hold this role. Reassign them to another role before deleting it.`,
            );
        }

        await this.prisma.platformRole.delete({ where: { id: roleId } });
        return { message: 'Role deleted.' };
    }

    // ---- Helpers ----

    private async findPlatformOrThrow(id: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id } });
        if (!platform) throw new NotFoundException('Platform not found.');
        return platform;
    }

    private async findRoleOrThrow(platformId: string, roleId: string) {
        const role = await this.prisma.platformRole.findUnique({ where: { id: roleId } });
        if (!role || role.platformId !== platformId) {
            throw new NotFoundException('Role not found on this platform.');
        }
        return role;
    }

    private async assertCanView(actor: Actor, platform: { id: string; ownerId: string }) {
        if (platform.ownerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) return;
        const { isAdmin, permissions } = await this.access.getEffectivePermissions(actor, platform);
        if (isAdmin || permissions.size > 0) return;
        throw new NotFoundException('Platform not found.');
    }

    /**
     * The permission-ceiling rule: `keys` must be a subset of what `actor` themselves currently
     * holds on `platform`. The owner and ADMIN implicitly hold everything in the catalog, so this
     * only ever actually restricts a custom-role holder who was themselves granted
     * `PLATFORM_MANAGE_ROLES` but not every other permission.
     */
    private async assertGrantablePermissions(actor: Actor, platform: { id: string; ownerId: string }, keys: PlatformPermissionKey[]) {
        const { permissions } = await this.access.getEffectivePermissions(actor, platform);
        const notOwned = keys.filter((key) => !permissions.has(key));
        if (notOwned.length > 0) {
            throw new ForbiddenException(
                `You cannot grant permission(s) you do not hold yourself: ${notOwned.join(', ')}.`,
            );
        }
    }

    private async resolvePermissionIds(keys: PlatformPermissionKey[]) {
        const rows = await this.prisma.platformPermission.findMany({ where: { key: { in: keys } } });
        if (rows.length !== keys.length) {
            // Should only ever happen if PlatformPermissionsSyncService hasn't run yet after a
            // fresh deploy - the DTO already validates keys against the code constant.
            throw new NotFoundException('One or more permissions are not yet registered in the catalog.');
        }
        return rows.map((row) => ({ platformPermissionId: row.id }));
    }

}
