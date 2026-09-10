import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BackupService } from './backup.service';

/**
 * Focused unit tests for `BackupService.resolveDumpPath()` - the path-traversal defense added
 * as part of the audit #6 fix (the previously-missing `GET /backup/download` route now exists
 * because of this method, so it deserves to be tested directly against a real filesystem rather
 * than a mocked one, since path-traversal bugs are exactly the kind of thing an over-mocked
 * `fs` can hide).
 */
describe('BackupService.resolveDumpPath (audit #6)', () => {
    let service: BackupService;
    let outputDir: string;

    beforeEach(() => {
        outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-spec-'));

        const configServiceMock = {
            get: jest.fn().mockReturnValue(outputDir),
            getOrThrow: jest.fn(),
        };

        service = new BackupService(configServiceMock as any, {} as any, {} as any);
    });

    afterEach(() => {
        fs.rmSync(outputDir, { recursive: true, force: true });
    });

    it('résout un nom de fichier de dump valide et existant', () => {
        const fileName = 'platform-abc_20260101-120000.sql.gz';
        fs.writeFileSync(path.join(outputDir, fileName), 'fake dump content');

        const resolved = service.resolveDumpPath(fileName);

        expect(resolved).toBe(path.join(outputDir, fileName));
    });

    it("lève NotFoundException si le fichier n'existe pas sur disque", () => {
        expect(() => service.resolveDumpPath('platform-abc_20260101-120000.sql.gz')).toThrow(
            NotFoundException,
        );
    });

    it('rejette un nom contenant un séparateur de chemin ("/") - tentative de traversal', () => {
        expect(() => service.resolveDumpPath('../../etc/passwd')).toThrow(BadRequestException);
    });

    it('rejette un nom contenant un séparateur de chemin ("\\\\")', () => {
        expect(() => service.resolveDumpPath('..\\..\\windows\\system32')).toThrow(
            BadRequestException,
        );
    });

    it("rejette un nom qui ne correspond pas au motif attendu (n'importe quelle extension)", () => {
        expect(() => service.resolveDumpPath('not-a-dump.txt')).toThrow(BadRequestException);
    });

    it('rejette une chaîne vide', () => {
        expect(() => service.resolveDumpPath('')).toThrow(BadRequestException);
    });

    it('rejette un nom absolu déguisé (pas de séparateur mais résolution hors du dossier)', () => {
        // Le pattern regex à lui seul bloque déjà tout ce qui contient ':' ou débute par '/',
        // donc ce cas confirme surtout que la double vérification (regex + path.relative)
        // ne casse rien pour un nom parfaitement valide par ailleurs.
        expect(() => service.resolveDumpPath('C:evil.sql.gz')).toThrow(BadRequestException);
    });
});

/**
 * BUGFIX (found in production against a real Postgres instance, 2026-09-10):
 * `ProvisioningService` builds Prisma-style connection URLs (`?schema=public`), which `pg_dump`
 * rejects outright - its libpq URI parser doesn't recognize `schema` as a connection parameter
 * (`pg_dump: erreur : paramètre de la requête URI invalide : « schema »`). Every dump path
 * (`dumpOrchestratorDatabase`, `dumpPlatformDatabase`, `dumpAllPlatformDatabases`) funnels
 * through the same private `toLibpqConnectionUrl()`, so this one test covers all of them.
 */
describe('BackupService.toLibpqConnectionUrl (production bugfix)', () => {
    let service: BackupService;

    beforeEach(() => {
        service = new BackupService({ get: jest.fn(), getOrThrow: jest.fn() } as any, {} as any, {} as any);
    });

    const callPrivate = (url: string): string => (service as any).toLibpqConnectionUrl(url);

    it('retire le paramètre "?schema=public" que pg_dump ne reconnaît pas', () => {
        const result = callPrivate('postgresql://user:pass@localhost:5432/mydb?schema=public');
        expect(result).toBe('postgresql://user:pass@localhost:5432/mydb');
    });

    it('préserve les identifiants (y compris avec des caractères spéciaux encodés)', () => {
        const password = encodeURIComponent('p@ss/word!$%');
        const result = callPrivate(`postgresql://user:${password}@localhost:5432/mydb?schema=public`);
        expect(result).toContain(`user:${password}@localhost:5432/mydb`);
    });

    it("préserve les autres paramètres de requête éventuels tout en retirant uniquement 'schema'", () => {
        const result = callPrivate('postgresql://user:pass@localhost:5432/mydb?schema=public&sslmode=require');
        expect(result).toBe('postgresql://user:pass@localhost:5432/mydb?sslmode=require');
    });

    it("ne modifie pas une URL qui n'a pas de paramètre 'schema'", () => {
        const result = callPrivate('postgresql://user:pass@localhost:5432/mydb');
        expect(result).toBe('postgresql://user:pass@localhost:5432/mydb');
    });
});
