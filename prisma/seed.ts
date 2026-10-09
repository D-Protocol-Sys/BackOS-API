import 'dotenv/config';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as bcrypt from 'bcrypt';
import { PrismaClient, UserStatus } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PERMISSION_DESCRIPTIONS, PERMISSIONS } from '../src/common/constants/permissions.constant';

// Import configuration factories
import databaseConfig from '../src/config/database.config';
import ownerConfig from '../src/config/owner.config';
import appConfig from '../src/config/app.config';

// Instantiate configuration objects
const dbConf = databaseConfig();
const ownerConf = ownerConfig();
const appConf = appConfig();

// Initialize Prisma Client with PostgreSQL adapter
const adapter = new PrismaPg({ connectionString: dbConf.url });
const prisma = new PrismaClient({ adapter });

async function main() {
    
    const allPermissionKeys = Object.values(PERMISSIONS);

    // 1. Seed system permissions (Idempotent upsert)
    for (const key of allPermissionKeys) {
        await prisma.permission.upsert({
            where: { key },
            update: { description: PERMISSION_DESCRIPTIONS[key] },
            create: { key, description: PERMISSION_DESCRIPTIONS[key] },
        });
    }

    // 2. Define application roles and assign permission mappings
    const rolesDefinition: Record<string, { level: number; perms: string[] | 'ALL' }> = {
        
        owner: { level: 0, perms: 'ALL' },

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
            PERMISSIONS.FILE_MANAGE,
            PERMISSIONS.PLANNING_READ,
            PERMISSIONS.PLANNING_MANAGE,
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

    // 3. Create initial System Owner (Genesis User) if database is empty
    const existingUsers = await prisma.user.count();

    if (existingUsers === 0) {
        
        // Ensure all required Owner attributes are provided in the environment
        if (
            !ownerConf.workEmail ||
            !ownerConf.personalEmail ||
            !ownerConf.firstName ||
            !ownerConf.lastName ||
            !ownerConf.username
        ) {
            throw new Error("❌ All OWNER_* configuration parameters must be defined in the environment.");
        }

        const ownerRole = await prisma.role.findUniqueOrThrow({ where: { name: 'owner' } });

        const genesisUser = await prisma.user.create({
            data: {
                workEmail: ownerConf.workEmail,
                personalEmail: ownerConf.personalEmail,
                firstName: ownerConf.firstName,
                lastName: ownerConf.lastName,
                username: ownerConf.username,
                status: UserStatus.INVITED,
            },
        });

        await prisma.userRole.create({ 
            data: { userId: genesisUser.id, roleId: ownerRole.id } 
        });

        // Generate secure activation token and numeric code
        const rawToken = crypto.randomBytes(32).toString('hex');
        const code = crypto.randomInt(100000, 1000000).toString();

        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const codeHash = await bcrypt.hash(code, appConf.bcryptSaltRounds);

        await prisma.invitation.create({
            data: {
                userId: genesisUser.id,
                tokenHash,
                codeHash,
                expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000), // Valid for 48 hours
            },
        });

        const activationDetails = [
            '🔑 Initial Owner account created — Complete activation using the details below:',
            `   Work Email     : ${genesisUser.workEmail}`,
            `   Personal Email : ${genesisUser.personalEmail}`,
            `   Activation Link: ${appConf.frontendUrl}/activate?token=${rawToken}`,
            `   OTP Code       : ${code}`,
        ].join('\n');

        // SECURITY FIX (SEC-031): in production the activation secrets used to be printed to
        // stdout, i.e. into container logs kept by Docker / the log pipeline. They are now written
        // to a 0600 file (SEED_ACTIVATION_FILE, default ./owner-activation.txt) that the operator
        // reads once and deletes. Outside production (dev, tests - the e2e setup parses stdout)
        // they are still printed.
        if (process.env.NODE_ENV === 'production') {
            const target = path.resolve(process.env.SEED_ACTIVATION_FILE || 'owner-activation.txt');
            fs.writeFileSync(target, activationDetails + '\n', { mode: 0o600 });
            console.log(`\n🔑 Initial Owner account created. Activation details written to ${target} (mode 0600) - read it, then delete it.\n`);
        } else {
            console.log(`\n${activationDetails}\n`);
        }
    }

    console.log('✅ Database seed completed: Permissions, roles, and initial system user created.');
}

main()
    .catch((e) => {
        console.error('❌ Database seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });