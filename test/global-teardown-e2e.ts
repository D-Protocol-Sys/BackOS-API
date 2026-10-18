import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { OWNER_INVITATION_FILE } from './helpers/owner-invitation-file';

/**
 * Jest `globalTeardown` - counterpart to global-setup-e2e.ts. Set KEEP_TEST_INFRA=1 to skip
 * this (e.g. while iterating locally on a single spec file repeatedly) and reuse the same
 * containers across runs instead of paying the Postgres/Redis startup cost every time.
 */
export default async function globalTeardown() {
    // Contains the owner's raw activation token/code/email in plaintext (see
    // global-setup-e2e.ts) - always removed, even when KEEP_TEST_INFRA=1 keeps the containers
    // up, since a stale copy would let anyone with repo access activate that owner account.
    if (fs.existsSync(OWNER_INVITATION_FILE)) fs.unlinkSync(OWNER_INVITATION_FILE);

    if (process.env.KEEP_TEST_INFRA === '1') {
        console.log('[e2e] KEEP_TEST_INFRA=1 - leaving test infra running.');
        return;
    }
    const composeFile = path.resolve(__dirname, '..', 'deploy', 'docker-compose.test.yml');
    console.log('[e2e] Stopping test infra...');
    execSync(`docker compose -f "${composeFile}" down -v`, { stdio: 'inherit' });
}
