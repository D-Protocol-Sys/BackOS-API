import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

/**
 * CryptoService protège au repos les secrets TOTP (MFA) et les mots de passe des bases
 * générées pour chaque plateforme - une régression silencieuse ici (mauvaise clé dérivée,
 * IV réutilisé, tag d'intégrité non vérifié) est un incident de sécurité, pas un simple bug.
 * Aucun test n'existait avant celui-ci. Voir docs/TESTS_COVERAGE_AUDIT.md.
 */
describe('CryptoService', () => {
    const encryptionKeyHex = 'a'.repeat(64); // 32 bytes hex - format exigé par env.validation.ts
    let service: CryptoService;

    beforeEach(() => {
        const configService = {
            getOrThrow: (key: string) => {
                if (key === 'security.encryptionKey') return encryptionKeyHex;
                throw new Error(`clé de config inattendue: ${key}`);
            },
        } as unknown as ConfigService;
        service = new CryptoService(configService);
    });

    describe('encrypt / decrypt (clé dérivée par hash, hex)', () => {
        it("un round-trip restitue exactement la valeur d'origine", () => {
            const plain = 'JBSWY3DPEHPK3PXP'; // forme typique d'un secret TOTP en base32
            const ciphertext = service.encrypt(plain);
            expect(service.decrypt(ciphertext)).toBe(plain);
        });

        it('produit un format IV:TAG:DATA en hexadécimal avec un IV de 12 octets', () => {
            const ciphertext = service.encrypt('valeur');
            const parts = ciphertext.split(':');
            expect(parts).toHaveLength(3);
            expect(parts[0]).toHaveLength(24); // 12 bytes -> 24 hex chars
            expect(parts.every((p) => /^[0-9a-f]+$/.test(p))).toBe(true);
        });

        it('deux chiffrements de la même valeur ne sont JAMAIS identiques (IV aléatoire)', () => {
            const a = service.encrypt('valeur-identique');
            const b = service.encrypt('valeur-identique');
            expect(a).not.toBe(b);
        });

        it("rejette un ciphertext dont le tag d'authentification a été altéré (intégrité)", () => {
            const [iv, tag, data] = service.encrypt('secret').split(':');
            const tamperedTag = tag.slice(0, -2) + (tag.slice(-2) === '00' ? '01' : '00');
            expect(() => service.decrypt([iv, tamperedTag, data].join(':'))).toThrow();
        });

        it('rejette un format invalide (pas 3 segments)', () => {
            expect(() => service.decrypt('pasunformatvalide')).toThrow(BadRequestException);
        });
    });

    describe('encryptWithRawKey / decryptWithRawKey (clé fournie, base64)', () => {
        it("un round-trip restitue exactement la valeur d'origine", () => {
            const plain = 'mot-de-passe-genere-pour-une-db-de-plateforme';
            const ciphertext = service.encryptWithRawKey(plain, encryptionKeyHex);
            expect(service.decryptWithRawKey(ciphertext, encryptionKeyHex)).toBe(plain);
        });

        it('échoue si déchiffré avec une clé différente de celle utilisée pour chiffrer', () => {
            const ciphertext = service.encryptWithRawKey('valeur', encryptionKeyHex);
            const otherKey = 'b'.repeat(64);
            expect(() => service.decryptWithRawKey(ciphertext, otherKey)).toThrow();
        });

        it('produit un format IV:TAG:DATA en base64, distinct du schéma hex ci-dessus', () => {
            const ciphertext = service.encryptWithRawKey('valeur', encryptionKeyHex);
            expect(ciphertext.split(':')).toHaveLength(3);
            // Un ciphertext base64 contient typiquement des caractères hors [0-9a-f] (+, /, =, majuscules).
            expect(/[A-Z+/=]/.test(ciphertext)).toBe(true);
        });

        it('rejette un format invalide (segment manquant)', () => {
            expect(() => service.decryptWithRawKey('a:b', encryptionKeyHex)).toThrow(BadRequestException);
        });
    });
});
