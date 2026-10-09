import { platformSlugToDbName, platformSlugToDbUser, shadowDatabaseRoleName } from './db-identifier.util';

describe('db-identifier.util (audit DB-003)', () => {
    const saved = process.env.SERVER_NAME;
    beforeEach(() => {
        process.env.SERVER_NAME = 'backos';
    });
    afterAll(() => {
        process.env.SERVER_NAME = saved;
    });

    it('produit des noms distincts pour deux plateformes dont les slugs se confondent après normalisation', () => {
        const longA = 'a'.repeat(60) + '-one';
        const longB = 'a'.repeat(60) + '-two';
        expect(platformSlugToDbName(longA, 'id-1')).not.toBe(platformSlugToDbName(longB, 'id-2'));
        expect(platformSlugToDbUser(longA, 'id-1')).not.toBe(platformSlugToDbUser(longB, 'id-2'));
    });

    it('est déterministe pour une même plateforme', () => {
        expect(platformSlugToDbName('portfolio', 'p-1')).toBe(platformSlugToDbName('portfolio', 'p-1'));
    });

    it('respecte la limite de 63 octets de PostgreSQL, même avec un SERVER_NAME long', () => {
        process.env.SERVER_NAME = 'a-very-long-server-name-that-goes-on-and-on';
        const slug = 'x'.repeat(80);
        expect(Buffer.byteLength(platformSlugToDbName(slug, 'p-1'))).toBeLessThanOrEqual(63);
        expect(Buffer.byteLength(platformSlugToDbUser(slug, 'p-1'))).toBeLessThanOrEqual(63);
        expect(Buffer.byteLength(shadowDatabaseRoleName())).toBeLessThanOrEqual(63);
    });

    it("n'utilise que des caractères d'identifiant SQL sûrs", () => {
        expect(platformSlugToDbName('My Platform!', 'p-1')).toMatch(/^[a-z0-9_]+$/);
    });
});
