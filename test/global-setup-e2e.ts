import * as path from 'path';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';

/**
 * Jest `globalSetup` - runs ONCE in its own process before any test file, unlike `setupFiles`
 * (test/env-e2e.ts) which runs once per test file. Responsible for everything that only needs
 * doing a single time for the whole run: bringing up deploy/docker-compose.test.yml, applying
 * migrations, seeding, and capturing the owner's activation token/code for auth.helper.ts.
 */
export default async function globalSetup() {
    dotenv.config({ path: path.resolve(__dirname, '..', '.env.test') });

    const composeFile = path.resolve(__dirname, '..', 'deploy', 'docker-compose.test.yml');
    const repoRoot = path.resolve(__dirname, '..');

    console.log('[e2e] Starting test infra (Postgres + Redis)...');
    // `--wait` blocks until both services report healthy (see the healthcheck: blocks in
    // docker-compose.test.yml) - without it, migrate below could race an unready Postgres.
    execSync(`docker compose -f "${composeFile}" up -d --wait`, { stdio: 'inherit' });

    console.log('[e2e] Applying Prisma migrations to the test database...');
    execSync('pnpm exec prisma migrate deploy', { stdio: 'inherit', env: { ...process.env }, cwd: repoRoot });

    // Test Postgres runs on a tmpfs data dir (see docker-compose.test.yml) - always empty on a
    // fresh `up`, so prisma/seed.ts's `if (existingUsers === 0)` branch always fires and prints
    // a fresh owner invitation every run. Captured (not `stdio: 'inherit'`) so it can be
    // regex-parsed below - still forwarded to the console afterwards for visibility/debugging.
    console.log('[e2e] Seeding (permissions, roles, owner)...');
    const seedOutput = execSync('pnpm exec prisma db seed', {
        encoding: 'utf-8',
        env: { ...process.env },
        cwd: repoRoot,
    });
    console.log(seedOutput);

    // Matches prisma/seed.ts's own console.log format exactly - see the "Initial Owner account
    // created" block. If that format ever changes, update these two patterns to match.
    const tokenMatch = seedOutput.match(/Activation Link\s*:\s*\S*\?token=([a-f0-9]+)/);
    const codeMatch = seedOutput.match(/OTP Code\s*:\s*(\d{6})/);
    const emailMatch = seedOutput.match(/Work Email\s*:\s*(\S+)/);

    if (!tokenMatch || !codeMatch || !emailMatch) {
        throw new Error(
            '[e2e] Could not find the owner activation token/code/email in the seed output above. ' +
                "Either the DB was not empty (owner already existed - is docker-compose.test.yml's " +
                "tmpfs volume actually being reset between runs?), or prisma/seed.ts's console.log " +
                "format changed and test/global-setup-e2e.ts's regex needs updating.",
        );
    }

    fs.writeFileSync(
        path.resolve(repoRoot, '.e2e-owner-invitation.json'),
        JSON.stringify({ token: tokenMatch[1], code: codeMatch[1], workEmail: emailMatch[1] }, null, 2),
    );

    console.log('[e2e] Test infra ready.');
}
