import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prismamodels/client';
import { generateSecret } from 'otplib';

/**
 * Guards the two things that stopped the whole end-to-end suite from starting, and that have
 * nothing to do with the database: the way Jest loads modules.
 *
 *  1. `otplib` (and its dependencies) are ES-module-only packages.
 *  2. The Prisma client loads its query engine with a dynamic `import()`.
 *
 * If one of them breaks again (a new Jest, a new TypeScript module setting, a new dependency), this
 * file fails first and says so, instead of every other end-to-end test failing with a cryptic error.
 * See tsconfig.e2e.json.
 */
describe('module loading in the end-to-end tests', () => {
    it('loads otplib, an ES-module-only dependency', () => {
        expect(typeof generateSecret()).toBe('string');
    });

    it('lets the Prisma client load its query engine (dynamic import)', async () => {
        // Port 1 is never open: the connection is expected to fail. What matters is that it fails
        // because of the unreachable database, and not because the engine could not be loaded.
        const client = new PrismaClient({
            adapter: new PrismaPg({
                connectionString: 'postgresql://u:p@127.0.0.1:1/db',
                connectionTimeoutMillis: 500,
            }),
        });

        let message = '';
        try {
            await client.$connect();
            await client.$queryRaw`SELECT 1`;
        } catch (error) {
            message = String((error as Error).message);
        } finally {
            await client.$disconnect().catch(() => undefined);
        }

        expect(message).not.toMatch(/dynamic import callback|Must use import to load ES Module/);
    });
});
