import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { MfaStatus, UserStatus } from '@prismamodels/enums';

/**
 * Focused unit tests for the two pieces of `AuthService` touched by this security pass:
 *   - `verifyStepUpTotp()` (audit #3 - new method): the step-up re-authentication gate now
 *     required before `DELETE /users/me` can proceed.
 *   - `loginWithRecoveryCode()`'s constant-time hash comparison (audit #9).
 *
 * `AuthService` has a plain constructor (no NestJS DI magic needed to instantiate it), so it is
 * built directly here with minimal jest.fn() mocks for exactly the dependencies each test path
 * touches - consistent with this repo's existing testing style (see
 * `role-hierarchy.service.spec.ts`).
 */
describe('AuthService', () => {
    let service: AuthService;
    let prismaMock: any;
    let auditLogMock: any;
    let mfaServiceMock: any;
    let recoveryCodeMock: any;

    beforeEach(() => {
        prismaMock = {
            user: { findUnique: jest.fn(), findFirst: jest.fn() },
            userMfa: { findUnique: jest.fn() },
            recoveryCode: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
            refreshToken: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
            // SEC-004: TOTP anti-replay is an atomic raw UPDATE of user_mfa."lastUsedStep".
            $executeRaw: jest.fn().mockResolvedValue(1),
            $queryRaw: jest.fn().mockResolvedValue([]),
        };
        auditLogMock = { log: jest.fn() };
        mfaServiceMock = { verify: jest.fn() };
        // verifyWithStep() mirrors verify() and reports the matched time step (anti-replay).
        mfaServiceMock.verifyWithStep = jest.fn(async (secret: string, code: string) => {
            const valid = await mfaServiceMock.verify(secret, code);
            return valid ? { valid: true, timeStep: 1_000_000 } : { valid: false };
        });
        recoveryCodeMock = {
            hashRecoveryCode: jest.fn((raw: string) => `hash(${raw})`),
        };

        service = new AuthService(
            prismaMock,
            { sign: jest.fn().mockReturnValue('signed.jwt.token') } as any, // jwtService
            { get: jest.fn().mockReturnValue(7) } as any, // configService
            {} as any, // emailService - unused by the methods under test
            auditLogMock,
            recoveryCodeMock,
            mfaServiceMock,
            { getEffectivePermissionKeys: jest.fn().mockResolvedValue(new Set()) } as any, // roleHierarchy
        );
    });

    describe('verifyStepUpTotp (audit #3)', () => {
        const activeUser = { id: 'user-1', status: UserStatus.ACTIVE };
        const activeMfa = { userId: 'user-1', status: MfaStatus.ACTIVE, secretEncrypted: 'enc-secret' };
        const context = { ipAddress: '203.0.113.1', userAgent: 'jest' };

        it('résout sans erreur quand le code TOTP est valide', async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUser);
            prismaMock.userMfa.findUnique.mockResolvedValue(activeMfa);
            mfaServiceMock.verify.mockResolvedValue(true);

            await expect(
                service.verifyStepUpTotp('user-1', '123456', context),
            ).resolves.toBeUndefined();

            expect(mfaServiceMock.verify).toHaveBeenCalledWith('enc-secret', '123456');
            expect(auditLogMock.log).not.toHaveBeenCalled();
        });

        it('rejette avec un message générique quand le code TOTP est invalide, et journalise un audit', async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUser);
            prismaMock.userMfa.findUnique.mockResolvedValue(activeMfa);
            mfaServiceMock.verify.mockResolvedValue(false);

            await expect(service.verifyStepUpTotp('user-1', '000000', context)).rejects.toThrow(
                UnauthorizedException,
            );

            expect(auditLogMock.log).toHaveBeenCalledWith(
                expect.objectContaining({ actorId: 'user-1', context }),
            );
        });

        it('rejette un code TOTP valide déjà utilisé (anti-rejeu, SEC-004)', async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUser);
            prismaMock.userMfa.findUnique.mockResolvedValue(activeMfa);
            mfaServiceMock.verify.mockResolvedValue(true);
            // The conditional UPDATE matched no row: this time step was already consumed.
            prismaMock.$executeRaw.mockResolvedValue(0);

            await expect(service.verifyStepUpTotp('user-1', '123456', context)).rejects.toThrow(
                UnauthorizedException,
            );
        });

        it("rejette si l'utilisateur n'existe pas, sans jamais appeler mfaService.verify (pas d'oracle)", async () => {
            prismaMock.user.findUnique.mockResolvedValue(null);

            await expect(service.verifyStepUpTotp('ghost', '123456', context)).rejects.toThrow(
                UnauthorizedException,
            );
            expect(mfaServiceMock.verify).not.toHaveBeenCalled();
        });

        it("rejette si l'utilisateur n'est pas ACTIVE (ex. suspendu)", async () => {
            prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1', status: UserStatus.SUSPENDED });

            await expect(service.verifyStepUpTotp('user-1', '123456', context)).rejects.toThrow(
                UnauthorizedException,
            );
            expect(mfaServiceMock.verify).not.toHaveBeenCalled();
        });

        it("rejette si l'utilisateur n'a pas de MFA active configurée", async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUser);
            prismaMock.userMfa.findUnique.mockResolvedValue(null);

            await expect(service.verifyStepUpTotp('user-1', '123456', context)).rejects.toThrow(
                UnauthorizedException,
            );
            expect(mfaServiceMock.verify).not.toHaveBeenCalled();
        });
    });

    describe('loginWithRecoveryCode - comparaison constant-time (audit #9)', () => {
        const context = { ipAddress: '203.0.113.1', userAgent: 'jest' };
        const activeUser = { id: 'user-1', status: UserStatus.ACTIVE, workEmail: 'a@b.com', username: 'a' };

        it('accepte un code de récupération correspondant exactement à un hash stocké', async () => {
            prismaMock.user.findFirst.mockResolvedValue(activeUser);
            // hashRecoveryCode('ABCDEF') -> 'hash(ABCDEF)', encodé en octets pour simuler un hash hex réel.
            const hashHex = Buffer.from('hash(ABCDEF)').toString('hex');
            recoveryCodeMock.hashRecoveryCode.mockReturnValue(hashHex);
            prismaMock.recoveryCode.findMany.mockResolvedValue([
                { id: 'code-1', codeHash: hashHex, usedAt: null },
            ]);
            prismaMock.recoveryCode.update.mockResolvedValue({});
            auditLogMock.log.mockResolvedValue(undefined);

            await expect(
                service.loginWithRecoveryCode({ loginIdentifier: 'a', recoveryCode: 'abcdef' } as any, context),
            ).resolves.toBeDefined();

            // Consumed atomically: only succeeds if the code is still unused (SEC-008).
            expect(prismaMock.recoveryCode.updateMany).toHaveBeenCalledWith({
                where: { id: 'code-1', usedAt: null },
                data: { usedAt: expect.any(Date) },
            });
        });

        it('rejette un code de récupération qui ne correspond à aucun hash stocké', async () => {
            prismaMock.user.findFirst.mockResolvedValue(activeUser);
            recoveryCodeMock.hashRecoveryCode.mockReturnValue(Buffer.from('wrong').toString('hex'));
            prismaMock.recoveryCode.findMany.mockResolvedValue([
                { id: 'code-1', codeHash: Buffer.from('right').toString('hex'), usedAt: null },
            ]);

            await expect(
                service.loginWithRecoveryCode({ loginIdentifier: 'a', recoveryCode: 'nope' } as any, context),
            ).rejects.toThrow(UnauthorizedException);
            expect(prismaMock.recoveryCode.update).not.toHaveBeenCalled();
        });

        it('ne plante pas (et rejette proprement) face à des hashs de longueurs différentes', async () => {
            // `timingSafeEqual` lève une exception native si les buffers n'ont pas la même
            // longueur - la vérification de longueur avant l'appel doit empêcher tout crash.
            prismaMock.user.findFirst.mockResolvedValue(activeUser);
            recoveryCodeMock.hashRecoveryCode.mockReturnValue(Buffer.from('short').toString('hex'));
            prismaMock.recoveryCode.findMany.mockResolvedValue([
                { id: 'code-1', codeHash: Buffer.from('a-much-longer-value').toString('hex'), usedAt: null },
            ]);

            await expect(
                service.loginWithRecoveryCode({ loginIdentifier: 'a', recoveryCode: 'x' } as any, context),
            ).rejects.toThrow(UnauthorizedException);
        });
    });

    describe('refreshTokens (audit SEC-002 / SEC-010)', () => {
        const future = new Date(Date.now() + 86_400_000);

        it("refuse et révoque toutes les sessions quand le compte n'est plus ACTIVE", async () => {
            prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
                id: 'rt-1', userId: 'user-1', expiresAt: future, revokedAt: null,
                user: { id: 'user-1', status: UserStatus.SUSPENDED, workEmail: 'a@b.com' },
            });

            await expect(service.refreshTokens('raw-token')).rejects.toThrow(UnauthorizedException);
            expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
            );
        });

        it('détecte la réutilisation d\'un jeton déjà tourné et révoque toutes les sessions', async () => {
            prismaMock.refreshToken.findUnique = jest.fn().mockResolvedValue({
                id: 'rt-1', userId: 'user-1', expiresAt: future, revokedAt: new Date(Date.now() - 60_000),
                user: { id: 'user-1', status: UserStatus.ACTIVE, workEmail: 'a@b.com' },
            });

            await expect(service.refreshTokens('raw-token')).rejects.toThrow(UnauthorizedException);
            expect(prismaMock.refreshToken.updateMany).toHaveBeenCalledWith(
                expect.objectContaining({ where: { userId: 'user-1', revokedAt: null } }),
            );
            expect(auditLogMock.log).toHaveBeenCalledWith(
                expect.objectContaining({ metadata: { reason: 'refresh-token-reuse-detected' } }),
            );
        });
    });
});
