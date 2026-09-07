import {
    Injectable,
    NotFoundException,
    ConflictException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { RoleHierarchyService } from '../common/services/role-hierarchy.service';

/**
 * Service managing user roles lifecycle, role-permission associations,
 * system role immutability checks, and hierarchy constraints.
 */
@Injectable()
export class RolesService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly roleHierarchy: RoleHierarchyService,
    ) {}

    /**
     * Lists all existing roles, including their nested permission definitions,
     * ordered alphabetically by name.
     */
    async list() {
        return this.prisma.role.findMany({
            include: { rolePermissions: { include: { permission: true } } },
            orderBy: { name: 'asc' },
        });
    }

    /**
     * Retrieves a single role by ID along with its assigned permissions.
     */
    async getById(id: string) {
        const role = await this.prisma.role.findUnique({
            where: { id },
            include: { rolePermissions: { include: { permission: true } } },
        });
        if (!role) throw new NotFoundException('Role not found.');
        return role;
    }

    /**
     * Creates a new role with assigned permissions after asserting 
     * that the requesting actor has sufficient hierarchy level privileges.
     *
     * SECURITY: two independent checks are required here, not one. Checking only the
     * numeric `level` (via `assertCanCreateAtLevel`) is NOT enough on its own, because
     * `level` and `permissionKeys` are unrelated fields - a low-authority actor could
     * otherwise create a role with a numerically "weak" level but attach every
     * permission in the system to it. `assertPermissionsAreOwnedByActor` closes that
     * gap by refusing to let anyone grant a permission they do not already hold.
     */
    async create(actorUserId: string, dto: CreateRoleDto) {

        await this.roleHierarchy.assertCanCreateAtLevel(actorUserId, dto.level);
        await this.roleHierarchy.assertPermissionsAreOwnedByActor(actorUserId, dto.permissionKeys);

        const permissions = await this.resolvePermissions(dto.permissionKeys);

        return this.prisma.role.create({
            data: {
                name: dto.name,
                description: dto.description,
                level: dto.level,
                rolePermissions: {
                    create: permissions.map((p) => ({ permissionId: p.id })),
                },
            },
            include: { rolePermissions: { include: { permission: true } } },
        });
    }

    /**
     * Updates role metadata (name, description).
     * Prevents updates to immutable system roles.
     */
    async update(actorUserId: string, id: string, dto: UpdateRoleDto) {
        await this.assertNotSystemRole(id, 'modify');
        return this.prisma.role.update({
            where: { id },
            data: dto,
            include: { rolePermissions: { include: { permission: true } } },
        });
    }

    /**
     * Overwrites all permission associations for a given role within a single database transaction.
     * Prevents updates to immutable system roles.
     *
     * SECURITY: this endpoint used to be the main privilege-escalation vector in the system -
     * it let anyone holding `ROLES_UPDATE` attach ANY permission (including ones they did not
     * personally hold) to ANY non-system role, regardless of that role's numeric level. We now
     * require the actor's own effective permission set to be a superset of `permissionKeys`
     * before the replacement is allowed to proceed.
     *
     * @param actorUserId - The authenticated user performing the replacement (used to enforce
     *   the "cannot grant what you do not have" invariant).
     * @param id - Target role ID whose permission set is being replaced.
     * @param permissionKeys - The full desired permission set for the role.
     */
    async replacePermissions(actorUserId: string, id: string, permissionKeys: string[]) {
        await this.assertNotSystemRole(id, 'modify permissions for');
        await this.roleHierarchy.assertPermissionsAreOwnedByActor(actorUserId, permissionKeys);
        const permissions = await this.resolvePermissions(permissionKeys);

        await this.prisma.$transaction([
            this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
            this.prisma.rolePermission.createMany({
                data: permissions.map((p) => ({ roleId: id, permissionId: p.id })),
            }),
        ]);

        return this.getById(id);
    }

    /**
     * Deletes a custom role by ID.
     * Prevents deletion of system roles, roles currently assigned to active users, or
     * (SECURITY FIX - audit #13) roles of equal or higher hierarchy rank than the actor.
     */
    async delete(actorUserId: string, id: string) {
        await this.assertNotSystemRole(id, 'delete');
        await this.roleHierarchy.assertCanDeleteRole(actorUserId, id);

        const assignedCount = await this.prisma.userRole.count({
            where: { roleId: id },
        });
        if (assignedCount > 0) {
            throw new ConflictException(
                'This role is still assigned to users. Remove it from users first.',
            );
        }

        return this.prisma.role.delete({ where: { id } });
    }

    // ---- Helpers ----

    /**
     * Resolves an array of permission key strings to their corresponding database entities.
     * Throws an exception if any requested key is invalid or non-existent.
     */
    private async resolvePermissions(keys: string[]) {
        const permissions = await this.prisma.permission.findMany({
            where: { key: { in: keys } },
        });
        if (permissions.length !== keys.length) {
            const foundKeys = permissions.map((p) => p.key);
            const missing = keys.filter((k) => !foundKeys.includes(k));
            throw new BadRequestException(
                `Unknown permissions: ${missing.join(', ')}`,
            );
        }
        return permissions;
    }

    /**
     * Asserts that a target role exists and is not a built-in system role (`isSystem = true`).
     */
    private async assertNotSystemRole(id: string, action: string) {
        const role = await this.prisma.role.findUnique({ where: { id } });
        if (!role) throw new NotFoundException('Role not found.');
        if (role.isSystem) {
            throw new ConflictException(
                `Cannot ${action} a system role ("${role.name}").`,
            );
        }
    }
}