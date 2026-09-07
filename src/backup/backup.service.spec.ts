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
