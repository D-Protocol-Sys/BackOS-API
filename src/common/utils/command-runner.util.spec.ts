import { buildChildProcessEnv, CommandFailedError, redactSecrets } from './command-runner.util';

describe('command-runner.util (audit SEC-001 / GEN-005)', () => {
    describe('redactSecrets', () => {
        it('masque le mot de passe des URLs de connexion', () => {
            const out = redactSecrets('connecting to postgresql://owner:S3cr3t!@db:5432/app?schema=public');
            expect(out).not.toContain('S3cr3t!');
            expect(out).toContain('postgresql://owner:***@db:5432/app');
        });

        it('masque les affectations de variables sensibles', () => {
            const out = redactSecrets('JWT_SECRET=abc123 DATABASE_PASSWORD="xyz" REDIS_KEY=k PORT=4000');
            expect(out).not.toMatch(/abc123|xyz|=k\b/);
            expect(out).toContain('PORT=4000');
        });

        it('laisse un texte sans secret inchangé', () => {
            expect(redactSecrets('pnpm install --frozen-lockfile')).toBe('pnpm install --frozen-lockfile');
        });
    });

    describe('buildChildProcessEnv', () => {
        const saved = { ...process.env };
        afterEach(() => {
            process.env = { ...saved };
        });

        it("ne transmet PAS les secrets de l'orchestrateur aux processus enfants", () => {
            process.env.JWT_SECRET = 'orchestrator-secret';
            process.env.ENCRYPTION_KEY = 'a'.repeat(64);
            process.env.DATABASE_URL = 'postgresql://root:pw@db/app';
            process.env.PATH = '/usr/bin';

            const env = buildChildProcessEnv({ DATABASE_URL: 'postgresql://tenant:pw@db/tenant' });

            expect(env.JWT_SECRET).toBeUndefined();
            expect(env.ENCRYPTION_KEY).toBeUndefined();
            expect(env.PATH).toBe('/usr/bin');
            expect(env.DATABASE_URL).toBe('postgresql://tenant:pw@db/tenant');
        });
    });

    describe('CommandFailedError', () => {
        it('ne laisse pas fuiter de mot de passe dans son message', () => {
            const error = new CommandFailedError(
                'pnpm exec prisma migrate deploy',
                '',
                'P1000: Authentication failed for postgresql://owner:TopSecret@db:5432/app',
            );
            expect(`${error.message} ${error.stderr}`).not.toContain('TopSecret');
        });
    });
});
