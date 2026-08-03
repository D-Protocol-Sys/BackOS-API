import 'dotenv/config';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from '../src/common/constants/permissions.constant';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
    
    const allPermissionKeys = Object.values(PERMISSIONS);

    for (const key of allPermissionKeys) {
        await prisma.permission.upsert({
            where: { key },
            update: { description: PERMISSION_DESCRIPTIONS[key] },
            create: { key, description: PERMISSION_DESCRIPTIONS[key] },
        });
    }

    const rolesDefinition: Record<string, { level: number; perms: string[] | 'ALL' }> = {

        owner: { level: 0,  perms: 'ALL' },

        admin: { level: 10, perms: [
            PERMISSIONS.USERS_READ,
            PERMISSIONS.USERS_UPDATE,
            PERMISSIONS.USERS_DEACTIVATE,
            PERMISSIONS.USERS_MANAGE_ROLES,
            PERMISSIONS.ROLES_READ,
            PERMISSIONS.PERMISSIONS_READ,
            PERMISSIONS.PLATFORM_CREATE,
            PERMISSIONS.PLATFORM_READ,
            PERMISSIONS.PLATFORM_UPDATE,
            PERMISSIONS.PLATFORM_DELETE,
            PERMISSIONS.PLATFORM_MANAGE_MEMBERS,
            PERMISSIONS.PLATFORM_TRANSFER_OWNERSHIP,
            PERMISSIONS.ENTITY_CREATE,
            PERMISSIONS.ENTITY_READ,
            PERMISSIONS.ENTITY_UPDATE,
            PERMISSIONS.ENTITY_DELETE,
            PERMISSIONS.FIELD_CREATE,
            PERMISSIONS.FIELD_READ,
            PERMISSIONS.FIELD_UPDATE,
            PERMISSIONS.FIELD_DELETE,
            PERMISSIONS.GENERATOR_EXECUTE,
            PERMISSIONS.GENERATION_READ,
        ]},

        developer: { level: 20, perms: [
            PERMISSIONS.PLATFORM_READ,
            PERMISSIONS.ENTITY_CREATE,
            PERMISSIONS.ENTITY_READ,
            PERMISSIONS.ENTITY_UPDATE,
            PERMISSIONS.ENTITY_DELETE,
            PERMISSIONS.FIELD_CREATE,
            PERMISSIONS.FIELD_READ,
            PERMISSIONS.FIELD_UPDATE,
            PERMISSIONS.FIELD_DELETE,
            PERMISSIONS.GENERATOR_EXECUTE,
            PERMISSIONS.GENERATION_READ,
        ]},

        viewer: { level: 30, perms: [PERMISSIONS.PLATFORM_READ, PERMISSIONS.GENERATION_READ] },

    };

    for (const [roleName, { level, perms }] of Object.entries(rolesDefinition)) {

        const role = await prisma.role.upsert({
            where: { name: roleName },
            update: { level },
            create: {
                name: roleName,
                level,
                isSystem: roleName === 'owner',
            },
        });

        const permissionKeys = perms === 'ALL' ? allPermissionKeys : perms;
        const permissions = await prisma.permission.findMany({
            where: { key: { in: permissionKeys } },
        });

        for (const permission of permissions) {
            await prisma.rolePermission.upsert({
                where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
                update: {},
                create: { roleId: role.id, permissionId: permission.id },
            });
        }
    }

    console.log('✅ Seed terminé : permissions et rôles créés.');
}

main()
    .catch((e) => {
        console.error(e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });