import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Service managing hierarchical permission security guards.
 * Enforces business rules where lower numerical values represent higher authority levels 
 * (e.g., Level 1 = SuperAdmin, Level 10 = Admin, Level 100 = User).
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
     * * @param actorUserId - User attempting to assign the role.
     * @param roleId - ID of the role to be granted.
     * @throws `NotFoundException` if the target role does not exist.
     * @throws `ForbiddenException` if actor tries to grant a role equal or superior to their own rank.
     */
    async assertCanGrantRole(actorUserId: string, roleId: string) {
        const actorLevel = await this.getBestLevel(actorUserId);
        const role = await this.prisma.role.findUnique({ where: { id: roleId } });
        
        if (!role) throw new NotFoundException('Role not found.');

        // Rejects execution if actor has no role or tries to assign a role with level <= actor's level
        if (actorLevel === null || actorLevel >= role.level) {
            throw new ForbiddenException(
                'Cannot assign a role of equal or higher rank than yourself.',
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
}