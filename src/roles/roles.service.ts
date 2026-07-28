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

@Injectable()
export class RolesService {

    constructor(
        private readonly prisma: PrismaService,
        private readonly roleHierarchy: RoleHierarchyService,
    ) {}

    async list() {
        return this.prisma.role.findMany({
            include: { rolePermissions: { include: { permission: true } } },
            orderBy: { name: 'asc' },
        });
    }

    async getById(id: string) {
        const role = await this.prisma.role.findUnique({
            where: { id },
            include: { rolePermissions: { include: { permission: true } } },
        });
        if (!role) throw new NotFoundException('Rôle introuvable.');
        return role;
    }

    async create(actorUserId: string, dto: CreateRoleDto) {

        await this.roleHierarchy.assertCanCreateAtLevel(actorUserId, dto.level);

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

    async update(id: string, dto: UpdateRoleDto) {
        await this.assertNotSystemRole(id, 'modifier');
        return this.prisma.role.update({
            where: { id },
            data: dto,
            include: { rolePermissions: { include: { permission: true } } },
        });
    }

    async replacePermissions(id: string, permissionKeys: string[]) {
        await this.assertNotSystemRole(id, 'modifier les permissions de');
        const permissions = await this.resolvePermissions(permissionKeys);

        await this.prisma.$transaction([
            this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
            this.prisma.rolePermission.createMany({
                data: permissions.map((p) => ({ roleId: id, permissionId: p.id })),
            }),
        ]);

        return this.getById(id);
    }

    async delete(id: string) {
        await this.assertNotSystemRole(id, 'supprimer');

        const assignedCount = await this.prisma.userRole.count({
            where: { roleId: id },
        });
        if (assignedCount > 0) {
            throw new ConflictException(
                'Ce rôle est encore assigné à des utilisateurs. Retire-le d\'abord.',
            );
        }

        return this.prisma.role.delete({ where: { id } });
    }

    private async resolvePermissions(keys: string[]) {
        const permissions = await this.prisma.permission.findMany({
            where: { key: { in: keys } },
        });
        if (permissions.length !== keys.length) {
            const foundKeys = permissions.map((p) => p.key);
            const missing = keys.filter((k) => !foundKeys.includes(k));
            throw new BadRequestException(
                `Permissions inconnues : ${missing.join(', ')}`,
            );
        }
        return permissions;
    }

    private async assertNotSystemRole(id: string, action: string) {
        const role = await this.prisma.role.findUnique({ where: { id } });
        if (!role) throw new NotFoundException('Rôle introuvable.');
        if (role.isSystem) {
            throw new ConflictException(
                `Impossible de ${action} un rôle système ("${role.name}").`,
            );
        }
    }
}
