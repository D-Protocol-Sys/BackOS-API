import 'dotenv/config';
import { createCipheriv, randomBytes, createHash } from 'crypto';
import { PrismaClient, UserStatus, MfaStatus } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { PERMISSIONS } from '../src/common/constants/permissions.constant';
import databaseConfig from '../src/config/database.config';

/**
 * OPT-IN, SEPARATE from prisma/seed.ts (which `prisma db seed` runs automatically and which
 * creates the real, full-privilege OWNER_* account) - this script is never run implicitly. Run
 * it explicitly (`pnpm exec ts-node prisma/seed-demo.ts`) whenever you want a public/shareable
 * account for demoing the product or letting someone try a new feature, WITHOUT handing out
 * real owner credentials.
 *
 * DESIGN CHOICE - why this account can be logged into with a PUBLISHED secret instead of adding
 * a new "demo login" bypass endpoint: `AuthService.login()` already requires a valid 6-digit
 * TOTP code and rejects anything else - that check is exactly as strong for this account as for
 * any other. There is no new authentication code path here, nothing that skips or weakens the
 * existing login flow - only two things are different from a normal account: (1) the TOTP
 * secret is intentionally not private (put it in a README/demo page/QR code for anyone to use),
 * and (2) the `demo` role below is deliberately READ-ONLY, so whoever logs in with it cannot
 * create, modify, or delete anything - can't touch other users, can't start/stop generated
 * backends (RUNTIME_MANAGE excluded), can't trigger new generations (GENERATOR_EXECUTE
 * excluded), can't see security audit logs (AUDIT_READ excluded). Worst case for a published
 * secret is "someone browses the demo data", never "someone mutates or destroys something".
 *
 * Idempotent (`upsert`) - safe to re-run; re-running with the SAME DEMO_TOTP_SECRET keeps any
 * previously-shared QR code/secret valid rather than silently invalidating it.
 */

const dbConf = databaseConfig();
const adapter = new PrismaPg({ connectionString: dbConf.url });
const prisma = new PrismaClient({ adapter });

// Mirrors CryptoService.encrypt() exactly (same AES-256-GCM scheme, same SHA-256(ENCRYPTION_KEY)
// key derivation) so the resulting ciphertext is decryptable by the running app's own
// MfaService/TotpService at login time - see src/common/services/crypto.service.ts's own doc
// comment for why this exact scheme must not drift from that file.
function encryptLikeCryptoService(value: string, encryptionKeySecret: string): string {
    const derivedKey = createHash('sha256').update(encryptionKeySecret).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', derivedKey, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString('hex'), tag.toString('hex'), encrypted.toString('hex')].join(':');
}

async function main() {
    const workEmail = process.env.DEMO_WORKEMAIL;
    const username = process.env.DEMO_USERNAME ?? 'demo';
    const firstName = process.env.DEMO_FIRSTNAME ?? 'Demo';
    const lastName = process.env.DEMO_LASTNAME ?? 'Account';
    // A fixed, known secret - NOT meant to be private. Generate one once (any base32 TOTP
    // secret works, e.g. via an authenticator app's "manual entry" or `otplib`'s
    // `generateSecret()`) and keep it stable in your own secrets store / demo page from then on.
    const totpSecret = process.env.DEMO_TOTP_SECRET;
    const encryptionKey = process.env.ENCRYPTION_KEY;

    if (!workEmail || !totpSecret || !encryptionKey) {
        throw new Error(
            '❌ DEMO_WORKEMAIL, DEMO_TOTP_SECRET, and ENCRYPTION_KEY must all be set in the environment.',
        );
    }

    // 1. Read-only demo role - see the doc comment above for the full rationale on each
    // exclusion. Only READ permissions across the board, and only for the areas worth showing
    // off; nothing that lets a demo visitor see other people's private data (USERS_READ
    // excluded) or the security trail (AUDIT_READ excluded).
    const demoPermissionKeys = [
        PERMISSIONS.PLATFORM_READ,
        PERMISSIONS.ENTITY_READ,
        PERMISSIONS.FIELD_READ,
        PERMISSIONS.PLANNING_READ,
        PERMISSIONS.CLIENT_READ,
        PERMISSIONS.CONTRACT_READ,
        PERMISSIONS.PROJECT_READ,
        PERMISSIONS.GENERATION_READ,
    ];

    const demoRole = await prisma.role.upsert({
        where: { name: 'demo' },
        update: { level: 90 }, // lowest privilege level in the hierarchy - see RoleHierarchyService
        create: { name: 'demo', level: 90, isSystem: true },
    });

    const demoPermissions = await prisma.permission.findMany({ where: { key: { in: demoPermissionKeys } } });
    if (demoPermissions.length !== demoPermissionKeys.length) {
        throw new Error(
            '❌ Some demo permission keys were not found - run `pnpm exec prisma db seed` first ' +
            '(prisma/seed.ts creates the base Permission rows this script only references).',
        );
    }
    for (const permission of demoPermissions) {
        await prisma.rolePermission.upsert({
            where: { roleId_permissionId: { roleId: demoRole.id, permissionId: permission.id } },
            update: {},
            create: { roleId: demoRole.id, permissionId: permission.id },
        });
    }

    // 2. The account itself - created directly ACTIVE with MFA already ACTIVE, deliberately
    // skipping the invitation/activation dance real accounts go through (see prisma/seed.ts) -
    // there is no email inbox to receive an activation link for a public demo account.
    const demoUser = await prisma.user.upsert({
        where: { workEmail },
        update: { status: UserStatus.ACTIVE },
        create: { workEmail, username, firstName, lastName, status: UserStatus.ACTIVE },
    });

    await prisma.userMfa.upsert({
        where: { userId: demoUser.id },
        update: { secretEncrypted: encryptLikeCryptoService(totpSecret, encryptionKey), status: MfaStatus.ACTIVE },
        create: {
            userId: demoUser.id,
            secretEncrypted: encryptLikeCryptoService(totpSecret, encryptionKey),
            status: MfaStatus.ACTIVE,
        },
    });

    await prisma.userRole.upsert({
        where: { userId_roleId: { userId: demoUser.id, roleId: demoRole.id } },
        update: {},
        create: { userId: demoUser.id, roleId: demoRole.id },
    });

    console.log('\n✅ Demo account ready:');
    console.log(`   Login (email or username): ${workEmail} / ${username}`);
    console.log('   TOTP secret: <the DEMO_TOTP_SECRET you configured - not printed here, keep it wherever you publish it>');
    console.log('   Role: demo (read-only - see the doc comment in this file for exactly what it can/cannot do)\n');
}

main()
    .catch((e) => {
        console.error('❌ Demo seed failed:', e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
