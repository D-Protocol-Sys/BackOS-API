import {
    Injectable,
    NotFoundException,
    ForbiddenException,
    BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { slugify } from '../common/utils/slugify.util';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { ProjectStatus } from '@prismamodels/client';

/**
 * Type defining the requesting user (actor) details, including ID and global system permissions.
 */
type Actor = { userId: string; permissions: string[] };

/**
 * Domain Service managing the lifecycle of Projects - product/feature ideas someone intends
 * to build and sell. A Project is intentionally lightweight compared to Platform: it has no
 * membership table of its own, just an optional single manager, so access control here is
 * simpler than `PlatformsService` (manager-or-global-permission, not a weighted role hierarchy).
 */
@Injectable()
export class ProjectsService {

    constructor(private readonly prisma: PrismaService) {}

    /**
     * Creates a new project. The creating user becomes the manager by default unless a
     * different `managerId` is explicitly provided.
     */
    async create(actor: Actor, dto: CreateProjectDto) {

        this.assertDatesAreConsistent(dto.startAt, dto.targetEndAt);

        if (dto.platformId) {
            await this.findPlatformOrThrow(dto.platformId);
        }

        const managerId = dto.managerId ?? actor.userId;
        await this.assertUserExists(managerId);

        const slug = dto.name ? await this.generateUniqueSlug(dto.name) : undefined;

        return this.prisma.project.create({
            data: {
                name: dto.name,
                slug,
                description: dto.description,
                status: dto.status ?? ProjectStatus.PLANNED,
                platformId: dto.platformId,
                managerId,
                startAt: dto.startAt ? new Date(dto.startAt) : undefined,
                targetEndAt: dto.targetEndAt ? new Date(dto.targetEndAt) : undefined,
                priority: dto.priority,
            },
        });
    }

    /**
     * Lists projects visible to the actor.
     * Actors with the global `PROJECT_READ` permission see every project; everyone else only
     * sees projects they manage. Supports optional filtering by platform and status.
     */
    async list(actor: Actor, filters: { platformId?: string; status?: ProjectStatus } = {}) {

        const canSeeAll = actor.permissions.includes(PERMISSIONS.PROJECT_READ);

        return this.prisma.project.findMany({
            where: {
                ...(filters.platformId ? { platformId: filters.platformId } : {}),
                ...(filters.status ? { status: filters.status } : {}),
                ...(canSeeAll ? {} : { managerId: actor.userId }),
            },
            orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        });
    }

    /**
     * Retrieves a single project by ID after verifying the actor has read access to it.
     */
    async getById(actor: Actor, id: string) {
        const project = await this.findProjectOrThrow(id);
        this.assertCanView(actor, project);
        return project;
    }

    /**
     * Updates project details. Reserved for the project's manager or a global
     * `PROJECT_UPDATE` permission holder.
     *
     * Educational note: flipping `status` to/from `COMPLETED` automatically manages
     * `completedAt` so callers don't have to remember to stamp/clear it by hand on every
     * status-changing request.
     */
    async update(actor: Actor, id: string, dto: UpdateProjectDto) {
        const project = await this.findProjectOrThrow(id);
        this.assertManagerOrGlobalPermission(actor, project, PERMISSIONS.PROJECT_UPDATE);

        this.assertDatesAreConsistent(
            dto.startAt ?? project.startAt?.toISOString(),
            dto.targetEndAt ?? project.targetEndAt?.toISOString(),
        );

        if (dto.platformId) {
            await this.findPlatformOrThrow(dto.platformId);
        }
        if (dto.managerId) {
            await this.assertUserExists(dto.managerId);
        }

        let completedAt = project.completedAt;
        if (dto.status && dto.status !== project.status) {
            if (dto.status === ProjectStatus.COMPLETED) {
                completedAt = completedAt ?? new Date();
            } else {
                completedAt = null;
            }
        }

        return this.prisma.project.update({
            where: { id },
            data: {
                name: dto.name,
                description: dto.description,
                status: dto.status,
                platformId: dto.platformId === null ? null : dto.platformId,
                managerId: dto.managerId === null ? null : dto.managerId,
                startAt: dto.startAt ? new Date(dto.startAt) : undefined,
                targetEndAt: dto.targetEndAt ? new Date(dto.targetEndAt) : undefined,
                priority: dto.priority,
                completedAt,
            },
        });
    }

    /**
     * Permanently deletes a project. Reserved for the project's manager or a global
     * `PROJECT_DELETE` permission holder.
     */
    async delete(actor: Actor, id: string) {
        const project = await this.findProjectOrThrow(id);
        this.assertManagerOrGlobalPermission(actor, project, PERMISSIONS.PROJECT_DELETE);

        await this.prisma.project.delete({ where: { id } });
        return { message: 'Project deleted.' };
    }

    // ---- Helpers ----

    /**
     * Helper retrieving a project entity or throwing a 404 exception.
     */
    private async findProjectOrThrow(id: string) {
        const project = await this.prisma.project.findUnique({ where: { id } });
        if (!project) throw new NotFoundException('Project not found.');
        return project;
    }

    /**
     * Helper verifying a target platform exists before linking a project to it.
     */
    private async findPlatformOrThrow(platformId: string) {
        const platform = await this.prisma.platform.findUnique({ where: { id: platformId } });
        if (!platform) throw new BadRequestException('Target platform not found.');
        return platform;
    }

    /**
     * Helper verifying a target manager account exists before assigning it.
     */
    private async assertUserExists(userId: string) {
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (!user) throw new BadRequestException('Target manager not found.');
        return user;
    }

    /**
     * Asserts actor has read access: the project's manager, or a global `PROJECT_READ` holder.
     */
    private assertCanView(actor: Actor, project: { managerId: string | null }) {
        if (project.managerId === actor.userId) return;
        if (actor.permissions.includes(PERMISSIONS.PROJECT_READ)) return;
        throw new NotFoundException('Project not found.');
    }

    /**
     * Asserts action is executed by the project's manager or an actor with the given global
     * permission.
     */
    private assertManagerOrGlobalPermission(
        actor: Actor,
        project: { managerId: string | null },
        globalPermission: string,
    ) {
        if (project.managerId === actor.userId) return;
        if (actor.permissions.includes(globalPermission)) return;
        throw new ForbiddenException('Action reserved for the project manager.');
    }

    /**
     * Ensures a project's planned start date is not after its target end date, when both are
     * present.
     */
    private assertDatesAreConsistent(startAt?: string, targetEndAt?: string) {
        if (!startAt || !targetEndAt) return;
        if (new Date(startAt).getTime() > new Date(targetEndAt).getTime()) {
            throw new BadRequestException('startAt must not be after targetEndAt.');
        }
    }

    /**
     * Generates a URL-friendly slug from the project name. Unlike `Platform.slug`, `Project.slug`
     * is not unique in the schema, but we still avoid pointless collisions where practical.
     */
    private async generateUniqueSlug(name: string): Promise<string> {
        const base = slugify(name);
        let candidate = base;
        let counter = 2;
        while (await this.prisma.project.findFirst({ where: { slug: candidate } })) {
            candidate = `${base}-${counter}`;
            counter++;
        }
        return candidate;
    }

}
