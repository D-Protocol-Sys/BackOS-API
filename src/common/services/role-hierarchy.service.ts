import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Service managing hierarchical permission security guards.
 *
 * Enforces two independent, and equally important, authorization rules across the
 * entire RBAC (Role-Based Access Control) system:
 *
 * 1. HIERARCHY (numeric "level"): lower numerical values represent higher authority
 *    (e.g., Level 1 = SuperAdmin, Level 10 = Admin, Level 100 = User). This controls
 *    *who can manage whom* (e.g. "can I suspend this user?", "can I create a role at
 *    this rank?").
 *
 * 2. PERMISSION CONTAINMENT ("you cannot grant what you do not have"): no actor should
 *    ever be able to hand out a permission key they do not themselves currently hold.
 *    This is what actually prevents privilege escalation - the numeric level alone is
 *    NOT sufficient, because level and permissions are stored as two independent
 *    concepts on the `Role` model. A user could otherwise create a brand new role with
 *    a numerically "weak" level (which passes the hierarchy check), silently attach
 *    every permission in the system to it, and then assign that role to themselves.
 *    Rule #2 closes that gap by validating the *actual permission set*, not just the
 *    label attached to it.
 */
@Injectable()
export class RoleHierarchyService {

    /**
     * @param prisma - Database access service powered by Prisma ORM.
     */
    constructor(private readonly prisma: PrismaService) {}

    /**
     * Finds the highest hierarchical rank (lowest numerical level) assigned to a user.
     * * @param userId - Unique identifier of the user to evaluate.
     * @returns The user's best numeric level (e.g. 1 is better than 10), or `null` if no roles are assigned.
     */
    async getBestLevel(userId: string): Promise<number | null> {
        // Query database for all roles assigned to the given user
        const userRoles = await this.prisma.userRole.findMany({
            where: { userId },
            include: { role: true },
        });

        // Return null if the user has no active role assignments
        if (userRoles.length === 0) return null;

        // Math.min finds the lowest numeric value (highest hierarchical authority)
        return Math.min(...userRoles.map((ur) => ur.role.level));
    }

    /**
     * Computes the full, de-duplicated set of permission keys a user effectively holds,
     * aggregated across every role assigned to them.
     *
     * This is the single source of truth for "what can this user actually do?" and is
     * intentionally shared between:
     *   - JWT issuance (`AuthService`), so tokens embed the real permission set;
     *   - the privilege-escalation guard below (`assertPermissionsAreOwnedByActor`),
     *     so nobody can hand out a permission they do not personally have.
     *
     * Keeping a single implementation avoids the two call sites silently drifting apart
     * over time (a common source of authorization bugs).
     *
     * @param userId - Unique identifier of the user whose effective permissions are computed.
     * @returns A Set of unique permission key strings (e.g. `Set{'users.read', 'users.update'}`).
     */
    async getEffectivePermissionKeys(userId: string): Promise<Set<string>> {
        const userRoles = await this.prisma.userRole.findMany({
            where: { userId },
            include: {
                role: {
                    include: {
                        rolePermissions: {
                            include: { permission: true },
                        },
                    },
                },
            },
        });

        const permissionKeys = new Set<string>();
        for (const userRole of userRoles) {
            for (const rolePermission of userRole.role.rolePermissions) {
                permissionKeys.add(rolePermission.permission.key);
            }
        }
        return permissionKeys;
    }

    /**
     * Asserts that an acting user strictly outranks a target user before allowing actions 
     * such as modifying, banning, or deleting their profile.
     * * @param actorUserId - User initiating the action.
     * @param targetUserId - User receiving the action.
     * @param action - Action verb description used for formatted error messages.
     * @throws `ForbiddenException` if the actor attempts to manage a user of equal or higher rank.
     */
    async assertSeniorToTarget(actorUserId: string, targetUserId: string, action: string) {
        // Bypasses check if a user is performing an action on themselves
        if (actorUserId === targetUserId) return;

        const actorLevel = await this.getBestLevel(actorUserId);
        const targetLevel = await this.getBestLevel(targetUserId);

        // Actors with no assigned roles cannot perform administrative actions
        if (actorLevel === null) {
            throw new ForbiddenException('No role assigned, action prohibited.');
        }

        // Targets with no roles assigned are automatically eligible for management actions
        if (targetLevel === null) return;

        // Enforces hierarchy rule: A lower or equal level value means equal or greater rank.
        // E.g., actorLevel (10) >= targetLevel (5) means actor is equal or weaker than target.
        if (actorLevel >= targetLevel) {
            throw new ForbiddenException(
                `Cannot ${action} a user of equal or higher rank than yourself.`,
            );
        }
    }

    /**
     * Asserts that an acting user has sufficient authority to grant a specific role to someone else.
     *
     * SECURITY FIX: this now checks two independent conditions instead of one. The original
     * implementation only compared the numeric `level` field, which is not a reliable signal
     * of how powerful a role actually is (level and permissions are independent attributes on
     * the `Role` model). We now ALSO verify that every permission carried by the target role is
     * already held by the actor - otherwise an actor could grant themselves a role that happens
     * to have a "weak" level but was loaded with every permission in the system.
     *
     * * @param actorUserId - User attempting to assign the role.
     * @param roleId - ID of the role to be granted.
     * @throws `NotFoundException` if the target role does not exist.
     * @throws `ForbiddenException` if actor tries to grant a role equal or superior to their own
     *         rank, OR a role that carries a permission the actor does not themselves hold.
     */
    async assertCanGrantRole(actorUserId: string, roleId: string) {
        const actorLevel = await this.getBestLevel(actorUserId);
        const role = await this.prisma.role.findUnique({
            where: { id: roleId },
            include: { rolePermissions: { include: { permission: true } } },
        });

        if (!role) throw new NotFoundException('Role not found.');

        // Rule #1 (hierarchy): actor must have a role, and cannot assign a role at level <= their own
        if (actorLevel === null || actorLevel >= role.level) {
            throw new ForbiddenException(
                'Cannot assign a role of equal or higher rank than yourself.',
            );
        }

        // Rule #2 (permission containment): the role being granted must not carry any permission
        // the actor does not already personally hold - this is what actually blocks escalation.
        const rolePermissionKeys = role.rolePermissions.map((rp) => rp.permission.key);
        await this.assertPermissionsAreOwnedByActor(actorUserId, rolePermissionKeys);
    }

    /**
     * SECURITY FIX (audit #13 - medium): asserts that an acting user has sufficient hierarchy
     * level to delete a given role.
     *
     * `RolesService.delete()` previously checked only that the role was non-system and had no
     * remaining user assignments - unlike `create`, `update`'s implicit checks, and
     * `assignRole`/`replacePermissions`, it never verified the actor's own rank against the
     * role being deleted. That meant a holder of `ROLES_DELETE` with a numerically weaker
     * (higher) level than a role could still delete that role's *definition*, as long as no one
     * currently held it - a narrow but real inconsistency in an otherwise carefully-guarded
     * hierarchy model. This mirrors the same Rule #1 check already used by `assertCanGrantRole`.
     *
     * @param actorUserId - User attempting to delete the role.
     * @param roleId - Target role ID.
     * @throws NotFoundException if the role does not exist.
     * @throws ForbiddenException if the actor's rank is not strictly senior to the role's.
     */
    async assertCanDeleteRole(actorUserId: string, roleId: string): Promise<void> {
        await this.assertCanManageRole(actorUserId, roleId, 'delete');
    }

    /**
     * SECURITY FIX (SEC-007): the actor must strictly outrank a role to rename it, change its
     * permissions or delete it. `RolesService.update()` / `replacePermissions()` used to skip
     * this check, so a holder of `roles.update` could strip or alter a more powerful role.
     */
    async assertCanManageRole(actorUserId: string, roleId: string, action = 'modify'): Promise<void> {
        const actorLevel = await this.getBestLevel(actorUserId);
        const role = await this.prisma.role.findUnique({ where: { id: roleId } });

        if (!role) throw new NotFoundException('Role not found.');

        if (actorLevel === null || actorLevel >= role.level) {
            throw new ForbiddenException(
                `Cannot ${action} a role of equal or higher rank than yourself.`,
            );
        }
    }

    /**
     * Asserts that an acting user has sufficient authority to create a new system role at a specified level.
     * * @param actorUserId - User creating the new role.
     * @param level - Numerical rank assigned to the new role being created.
     * @throws `ForbiddenException` if the created role would equal or exceed the actor's own rank.
     */
    async assertCanCreateAtLevel(actorUserId: string, level: number) {
        const actorLevel = await this.getBestLevel(actorUserId);

        // Prevents privilege escalation: Users cannot create roles of equal or higher authority (<= level)
        if (actorLevel === null || level <= actorLevel) {
            throw new ForbiddenException(
                'Cannot create a role of equal or higher rank than yourself.',
            );
        }
    }

    /**
     * SECURITY FIX (core of the privilege-escalation patch): asserts that every permission key
     * in `requestedKeys` is already held by the acting user.
     *
     * This is the "you cannot delegate what you do not have" invariant. It must be enforced
     * anywhere permissions are attached to a role - both when a role is first created
     * (`RolesService.create`) and whenever a role's permission set is replaced
     * (`RolesService.replacePermissions`). Without this check, the numeric `level` field was
     * the only guard, and level/permissions being independent fields made it possible to build
     * a nominally "weak" role that was in fact all-powerful.
     *
     * Users holding every permission in the system (e.g. the seeded `owner` role) will always
     * pass this check trivially, since their effective permission set is a superset of any
     * requested set.
     *
     * * @param actorUserId - User attempting to grant the listed permissions to a role.
     * @param requestedKeys - Permission keys the actor is trying to attach to a role.
     * @throws `ForbiddenException` listing the specific permission keys the actor does not hold.
     */
    async assertPermissionsAreOwnedByActor(actorUserId: string, requestedKeys: string[]): Promise<void> {
        if (requestedKeys.length === 0) return;

        const actorPermissionKeys = await this.getEffectivePermissionKeys(actorUserId);
        const disallowedKeys = requestedKeys.filter((key) => !actorPermissionKeys.has(key));

        if (disallowedKeys.length > 0) {
            throw new ForbiddenException(
                `Cannot grant permissions you do not hold yourself: ${disallowedKeys.join(', ')}.`,
            );
        }
    }
}
