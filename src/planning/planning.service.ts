import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { PlanningItemType, PlanningScope } from '@prismamodels/client';
import { UserStatus } from '@prismamodels/enums';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { CreatePlanningEntryDto } from './dto/create-planning-entry.dto';
import { UpdatePlanningEntryDto } from './dto/update-planning-entry.dto';
import { ReassignResponsibleDto } from './dto/reassign-responsible.dto';

/**
 * Represents the authenticated actor (user) executing an operation.
 * Used across the service for role-based and attribute-based access control.
 */
type Actor = {
    userId: string;
    permissions: string[];
};

/**
 * Type alias extracting field keys from CreatePlanningEntryDto.
 * Enables strict type checking when referencing payload fields.
 */
type PlanningPayloadField = keyof CreatePlanningEntryDto;

/**
 * Dynamic map representing raw or partial planning item payloads.
 */
type PlanningPayload = Partial<Record<PlanningPayloadField, unknown>>;

/**
 * Defines field validation constraints per PlanningItemType.
 * Ensures data integrity by strictly defining required and forbidden fields for each type.
 */
const TYPE_REQUIREMENTS: Record<
    PlanningItemType,
    { required: PlanningPayloadField[]; forbidden: PlanningPayloadField[] }
> = {
    EVENT: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate', 'status'],
    },
    TASK: {
        required: ['dueDate'],
        forbidden: ['startAt', 'endAt', 'targetDate'],
    },
    NOTE: {
        required: [],
        forbidden: ['startAt', 'endAt', 'dueDate', 'targetDate', 'status'],
    },
    MILESTONE: {
        required: ['targetDate'],
        forbidden: ['startAt', 'endAt', 'dueDate'],
    },
    SHIFT: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate'],
    },
    LEAVE: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate'],
    },
    ON_CALL: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate'],
    },
    MEETING: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate'],
    },
    HOLIDAY: {
        required: ['startAt', 'endAt'],
        forbidden: ['dueDate', 'targetDate', 'status'],
    },
};

/**
 * Validates a planning entry payload against predefined business rules.
 * Throws a BadRequestException if required fields are missing or forbidden fields are present.
 *
 * @param type The item type being validated (e.g., TASK, EVENT)
 * @param payload The request body payload containing candidate properties
 */
function validatePlanningEntryPayload(
    type: PlanningItemType,
    payload: PlanningPayload,
): void {
    const rules = TYPE_REQUIREMENTS[type];

    if (!rules) {
        throw new BadRequestException(`Unsupported planning item type: ${type}.`);
    }

    // Ensure all required fields are present and not null/undefined
    for (const field of rules.required) {
        if (payload[field] === undefined || payload[field] === null) {
            throw new BadRequestException(
                `The field "${field}" is required for an item of type ${type}.`,
            );
        }
    }

    // Ensure no forbidden fields are populated for this item type
    for (const field of rules.forbidden) {
        if (payload[field] !== undefined) {
            throw new BadRequestException(
                `The field "${field}" is not allowed for an item of type ${type}.`,
            );
        }
    }
}

/**
 * Core business domain service for planning management.
 * Handles logic for personal/platform planning scopes, access control, assignees, and data formatting.
 */
@Injectable()
export class PlanningService {
    constructor(private readonly prisma: PrismaService) {}

    // =========================================================================
    // PERSONAL PLANNING SECTION
    // =========================================================================

    /**
     * Creates a personal planning entry for the current actor.
     * Hierarchy: User -> Planning (PERSONAL scope) -> PlanningEntry
     */
    async createPersonal(actor: Actor, dto: CreatePlanningEntryDto) {
        validatePlanningEntryPayload(dto.type, dto);

        const planning = await this.getOrCreatePersonalPlanning(actor.userId);

        return this.prisma.planningEntry.create({
            data: {
                ...this.toCreateData(dto),
                planningId: planning.id,
                creatorId: actor.userId,
            },
        });
    }

    /**
     * Lists all personal entries belonging to the authenticated actor.
     * Optionally filters entries by PlanningItemType.
     */
    async listPersonal(actor: Actor, type?: PlanningItemType) {
        const planning = await this.findPersonalPlanning(actor.userId);

        if (!planning) {
            return [];
        }

        return this.prisma.planningEntry.findMany({
            where: {
                planningId: planning.id,
                ...(type ? { type } : {}),
            },
            orderBy: { createdAt: 'desc' },
            include: {
                attachments: true,
                assignees: {
                    include: {
                        user: {
                            select: { id: true, firstName: true, lastName: true },
                        },
                    },
                },
            },
        });
    }

    /**
     * Retrieves a specific personal planning entry by ID.
     */
    async getPersonalById(actor: Actor, id: string) {
        const planning = await this.findPersonalPlanning(actor.userId);

        if (!planning) {
            throw new NotFoundException('Item not found.');
        }

        const entry = await this.prisma.planningEntry.findFirst({
            where: {
                id,
                planningId: planning.id,
            },
            include: {
                attachments: true,
                assignees: {
                    include: {
                        user: {
                            select: { id: true, firstName: true, lastName: true },
                        },
                    },
                },
            },
        });

        if (!entry) {
            throw new NotFoundException('Item not found.');
        }

        return entry;
    }

    /**
     * Updates an existing personal planning entry.
     * Validates merged existing state with partial incoming changes.
     */
    async updatePersonal(actor: Actor, id: string, dto: UpdatePlanningEntryDto) {
        const entry = await this.getPersonalById(actor, id);

        // Validate merged state to enforce field rules after update
        validatePlanningEntryPayload(entry.type, {
            ...entry,
            ...dto,
        });

        return this.prisma.planningEntry.update({
            where: { id },
            data: this.toUpdateData(dto),
        });
    }

    /**
     * Deletes a personal planning entry.
     */
    async deletePersonal(actor: Actor, id: string) {
        await this.getPersonalById(actor, id);

        await this.prisma.planningEntry.delete({
            where: { id },
        });

        return { message: 'Item deleted successfully.' };
    }

    // =========================================================================
    // PLATFORM PLANNING SECTION
    // =========================================================================

    /**
     * Creates a planning entry attached to a specific platform.
     * Hierarchy: Platform -> Planning (PLATFORM scope) -> PlanningEntry
     */
    async createPlatformEntry(actor: Actor, platformId: string, dto: CreatePlanningEntryDto) {
        await this.assertCanEditPlatformPlanning(actor, platformId);
        validatePlanningEntryPayload(dto.type, dto);

        const planning = await this.getOrCreatePlatformPlanning(platformId, actor.userId);

        return this.prisma.planningEntry.create({
            data: {
                ...this.toCreateData(dto),
                planningId: planning.id,
                creatorId: actor.userId,
            },
        });
    }

    /**
     * Lists entries for a specific platform, with optional filter for self-assigned entries.
     */
    async listPlatformEntries(actor: Actor, platformId: string, assignedToMe: boolean = false) {
        await this.assertCanViewPlatformPlanning(actor, platformId);

        const planning = await this.findPlatformPlanning(platformId);

        if (!planning) {
            return [];
        }

        return this.prisma.planningEntry.findMany({
            where: {
                planningId: planning.id,
                ...(assignedToMe
                    ? { assignees: { some: { userId: actor.userId } } }
                    : {}),
            },
            orderBy: { createdAt: 'desc' },
            include: {
                attachments: true,
                assignees: {
                    include: {
                        user: {
                            select: { id: true, firstName: true, lastName: true },
                        },
                    },
                },
            },
        });
    }

    /**
     * Updates an entry within a platform planning scope.
     */
    async updatePlatformEntry(actor: Actor, platformId: string, id: string, dto: UpdatePlanningEntryDto) {
        await this.assertCanEditPlatformPlanning(actor, platformId);
        const entry = await this.findEntryInPlatformOrThrow(platformId, id);

        validatePlanningEntryPayload(entry.type, {
            ...entry,
            ...dto,
        });

        return this.prisma.planningEntry.update({
            where: { id },
            data: this.toUpdateData(dto),
        });
    }

    /**
     * Removes an entry from a platform planning.
     */
    async deletePlatformEntry(actor: Actor, platformId: string, id: string) {
        await this.assertCanEditPlatformPlanning(actor, platformId);
        await this.findEntryInPlatformOrThrow(platformId, id);

        await this.prisma.planningEntry.delete({
            where: { id },
        });

        return { message: 'Item deleted successfully.' };
    }

    /**
     * SECURITY FIX (audit #1/#5 follow-up): reassigns a platform Planning's "responsible" user
     * to a different active user.
     *
     * This is the missing counterpart to `Planning.responsible`'s `onDelete: SetNull` fix in
     * `schema.prisma` (see that field's comment) and to the pre-check in
     * `UsersService.hardDeleteUser()`: previously there was no way at all, via the API, to
     * change who is responsible for a platform's planning once created, which would have made
     * that pre-check a dead end for anyone actually holding the role. Mirrors
     * `PlatformsService.transferOwnership()`'s shape and validation.
     *
     * @param actor - Requesting user; must satisfy `assertCanEditPlatformPlanning` (platform
     *   owner, global `PLANNING_MANAGE`, or platform ADMIN member).
     * @param platformId - Target platform ID whose planning is being reassigned.
     * @param dto - Contains the new responsible user's ID.
     * @throws NotFoundException if the platform (or its planning) does not exist.
     * @throws BadRequestException if the new responsible user is invalid or inactive.
     */
    async reassignResponsible(actor: Actor, platformId: string, dto: ReassignResponsibleDto) {
        await this.assertCanEditPlatformPlanning(actor, platformId);

        const planning = await this.findPlatformPlanning(platformId);
        if (!planning) {
            throw new NotFoundException('This platform has no planning yet.');
        }

        const newResponsible = await this.prisma.user.findUnique({
            where: { id: dto.newResponsibleId },
        });
        if (!newResponsible || newResponsible.status !== UserStatus.ACTIVE) {
            throw new BadRequestException('The new responsible user is invalid or inactive.');
        }

        return this.prisma.planning.update({
            where: { id: planning.id },
            data: { responsibleId: dto.newResponsibleId },
        });
    }

    // =========================================================================
    // ASSIGNEES MANAGEMENT
    // =========================================================================

    /**
     * Assigns a user to a platform planning entry.
     * Verifies user membership or owner status on the platform prior to assignment.
     */
    async addAssignee(actor: Actor, platformId: string, entryId: string, userId: string) {
        await this.assertCanEditPlatformPlanning(actor, platformId);
        await this.findEntryInPlatformOrThrow(platformId, entryId);

        const membership = await this.prisma.platformMember.findUnique({
            where: {
                platformId_userId: { platformId, userId },
            },
        });

        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
        });

        if (!platform) {
            throw new NotFoundException('Platform not found.');
        }

        if (!membership && platform.ownerId !== userId) {
            throw new BadRequestException('This user is not a member of the platform.');
        }

        return this.prisma.planningEntryAssignee.upsert({
            where: {
                entryId_userId: { entryId, userId },
            },
            update: {},
            create: { entryId, userId },
        });
    }

    /**
     * Removes an assigned user from a platform planning entry.
     */
    async removeAssignee(actor: Actor, platformId: string, entryId: string, userId: string) {
        await this.assertCanEditPlatformPlanning(actor, platformId);
        await this.findEntryInPlatformOrThrow(platformId, entryId);

        await this.prisma.planningEntryAssignee.deleteMany({
            where: { entryId, userId },
        });

        return { message: 'Assignment removed successfully.' };
    }

    // =========================================================================
    // ACCESS CONTROL GUARDS
    // =========================================================================

    /**
     * Guarantees that the actor possesses read access to a specific entry.
     */
    async assertCanViewEntry(actor: Actor, entryId: string) {
        const entry = await this.findEntryOrThrow(entryId);

        if (!entry.planning) {
            throw new ForbiddenException('Planning context is missing.');
        }

        if (entry.planning.scope === PlanningScope.PERSONAL) {
            if (entry.planning.responsibleId !== actor.userId) {
                throw new ForbiddenException('Access denied.');
            }
            return;
        }

        if (entry.planning.scope === PlanningScope.PLATFORM) {
            if (!entry.planning.platformId) {
                throw new ForbiddenException('Platform planning context is missing.');
            }
            await this.assertCanViewPlatformPlanning(actor, entry.planning.platformId);
            return;
        }

        throw new ForbiddenException('Access denied.');
    }

    /**
     * Guarantees that the actor possesses write/edit authorization for a specific entry.
     */
    async assertCanEditEntry(actor: Actor, entryId: string) {
        const entry = await this.findEntryOrThrow(entryId);

        if (!entry.planning) {
            throw new ForbiddenException('Planning context is missing.');
        }

        if (entry.planning.scope === PlanningScope.PERSONAL) {
            if (entry.planning.responsibleId !== actor.userId) {
                throw new ForbiddenException('Access denied.');
            }
            return;
        }

        if (entry.planning.scope === PlanningScope.PLATFORM) {
            if (!entry.planning.platformId) {
                throw new ForbiddenException('Platform planning context is missing.');
            }
            await this.assertCanEditPlatformPlanning(actor, entry.planning.platformId);
            return;
        }

        throw new ForbiddenException('Access denied.');
    }

    // =========================================================================
    // RESOLUTION & RETRIEVAL HELPERS
    // =========================================================================

    /**
     * Queries the database for a personal planning container tied to a specific user.
     */
    private async findPersonalPlanning(userId: string) {
        return this.prisma.planning.findFirst({
            where: {
                scope: PlanningScope.PERSONAL,
                responsibleId: userId,
                platformId: null,
            },
        });
    }

    /**
     * Retrieves existing personal planning or lazily creates one if non-existent.
     */
    private async getOrCreatePersonalPlanning(userId: string) {
        const existing = await this.findPersonalPlanning(userId);

        if (existing) {
            return existing;
        }

        return this.prisma.planning.create({
            data: {
                name: 'Personal Planning',
                scope: PlanningScope.PERSONAL,
                responsibleId: userId,
            },
        });
    }

    /**
     * Queries database for a platform-bound planning entity.
     */
    private async findPlatformPlanning(platformId: string) {
        return this.prisma.planning.findUnique({
            where: { platformId },
        });
    }

    /**
     * Retrieves existing platform planning container or lazily instantiates it.
     */
    private async getOrCreatePlatformPlanning(platformId: string, responsibleId?: string) {
        const existing = await this.findPlatformPlanning(platformId);

        if (existing) {
            return existing;
        }

        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
            select: { name: true },
        });

        if (!platform) {
            throw new NotFoundException('Platform not found.');
        }

        return this.prisma.planning.create({
            data: {
                name: `${platform.name} Planning`,
                scope: PlanningScope.PLATFORM,
                platformId,
                responsibleId,
            },
        });
    }

    // =========================================================================
    // DATA MAPPING & TRANSFORMATIONS
    // =========================================================================

    /**
     * Maps creation DTO fields to Prisma create database format.
     * Ensures String ISO dates are converted to native JavaScript Date objects.
     */
    private toCreateData(dto: CreatePlanningEntryDto) {
        return {
            type: dto.type,
            title: dto.title,
            description: dto.description,
            status: dto.status,
            startAt: dto.startAt ? new Date(dto.startAt) : undefined,
            endAt: dto.endAt ? new Date(dto.endAt) : undefined,
            dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
            targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined,
        };
    }

    /**
     * Maps update DTO properties to Prisma update input.
     * Handles explicit partial updates (PATCH semantics) and converts dates or sets nulls.
     */
    private toUpdateData(dto: UpdatePlanningEntryDto) {
        return {
            ...(dto.title !== undefined && { title: dto.title }),
            ...(dto.description !== undefined && { description: dto.description }),
            ...(dto.status !== undefined && { status: dto.status }),
            ...(dto.startAt !== undefined && {
                startAt: dto.startAt ? new Date(dto.startAt) : null,
            }),
            ...(dto.endAt !== undefined && {
                endAt: dto.endAt ? new Date(dto.endAt) : null,
            }),
            ...(dto.dueDate !== undefined && {
                dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
            }),
            ...(dto.targetDate !== undefined && {
                targetDate: dto.targetDate ? new Date(dto.targetDate) : null,
            }),
        };
    }

    // =========================================================================
    // INTERNAL QUERY HELPERS
    // =========================================================================

    /**
     * Fetches entry by ID along with its associated planning container or throws NotFoundException.
     */
    private async findEntryOrThrow(id: string) {
        const entry = await this.prisma.planningEntry.findUnique({
            where: { id },
            include: { planning: true },
        });

        if (!entry) {
            throw new NotFoundException('Item not found.');
        }

        return entry;
    }

    /**
     * Fetches entry within a specific platform planning context or throws NotFoundException.
     */
    private async findEntryInPlatformOrThrow(platformId: string, id: string) {
        const planning = await this.findPlatformPlanning(platformId);

        if (!planning) {
            throw new NotFoundException('Planning not found.');
        }

        const entry = await this.prisma.planningEntry.findFirst({
            where: {
                id,
                planningId: planning.id,
            },
            include: { planning: true },
        });

        if (!entry) {
            throw new NotFoundException('Item not found.');
        }

        return entry;
    }

    // =========================================================================
    // PLATFORM PERMISSION CHECKS
    // =========================================================================

    /**
     * Validates read permission for a platform planning.
     * Checks platform ownership, global planning/platform permissions, or active membership.
     */
    private async assertCanViewPlatformPlanning(actor: Actor, platformId: string) {
        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
        });

        if (!platform) {
            throw new NotFoundException('Platform not found.');
        }

        // Grant access if actor is platform owner
        if (platform.ownerId === actor.userId) {
            return;
        }

        // Grant access if actor holds global read permissions
        if (actor.permissions.includes(PERMISSIONS.PLANNING_READ)) {
            return;
        }

        if (actor.permissions.includes(PERMISSIONS.PLATFORM_READ)) {
            return;
        }

        // Check if user is a registered member of the platform
        const membership = await this.prisma.platformMember.findUnique({
            where: {
                platformId_userId: {
                    platformId,
                    userId: actor.userId,
                },
            },
        });

        if (!membership) {
            throw new NotFoundException('Platform not found.');
        }
    }

    /**
     * Validates write permission for platform planning operations.
     * Requires platform ownership, global PLANNING_MANAGE permission, or platform ADMIN role.
     */
    private async assertCanEditPlatformPlanning(actor: Actor, platformId: string) {
        const platform = await this.prisma.platform.findUnique({
            where: { id: platformId },
        });

        if (!platform) {
            throw new NotFoundException('Platform not found.');
        }

        // Grant permission if actor is owner
        if (platform.ownerId === actor.userId) {
            return;
        }

        // Grant permission if actor holds global planning management permission
        if (actor.permissions.includes(PERMISSIONS.PLANNING_MANAGE)) {
            return;
        }

        // Grant permission if actor is platform ADMIN
        const membership = await this.prisma.platformMember.findUnique({
            where: {
                platformId_userId: {
                    platformId,
                    userId: actor.userId,
                },
            },
        });

        if (membership?.role === 'ADMIN') {
            return;
        }

        throw new ForbiddenException(
            'Only a platform administrator can manage its planning.',
        );
    }
}