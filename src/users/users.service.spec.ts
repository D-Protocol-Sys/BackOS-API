import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { UsersService } from './users.service';

/**
 * Focused unit tests for the new safeguards added to `UsersService`:
 *   - `hardDeleteUser()`'s planning pre-checks (audit #1/#5) - mirrors the pre-existing
 *     `platformOwned` pattern for `Planning.responsible` and `PlanningEntry.creatorId`.
 *   - `deleteOwnAccount()` (audit #3) - the step-up TOTP gate in front of self-service deletion.
 */
describe('UsersService', () => {
    let service: UsersService;
    let prismaMock: any;
    let roleHierarchyMock: any;
    let auditLogMock: any;
    let authServiceMock: any;

    const activeUserNoPlatforms = { id: 'user-1', platformOwned: [] };

    beforeEach(() => {
        prismaMock = {
            user: { findUnique: jest.fn(), delete: jest.fn().mockResolvedValue({}) },
            userRole: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn() },
            planning: {
                count: jest.fn(),
                deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            planningEntry: { count: jest.fn() },
            // hardDeleteUser() now also removes the user's uploaded files from disk (FILE-002).
            fileAsset: { findMany: jest.fn().mockResolvedValue([]) },
            $transaction: jest.fn().mockImplementation((cb) => (Array.isArray(cb) ? Promise.all(cb) : cb(prismaMock))),
        };
        roleHierarchyMock = { assertSeniorToTarget: jest.fn().mockResolvedValue(undefined) };
        auditLogMock = { log: jest.fn().mockResolvedValue(undefined) };
        authServiceMock = { verifyStepUpTotp: jest.fn(), revokeAllRefreshTokens: jest.fn().mockResolvedValue(0) };

        service = new UsersService(
            prismaMock,
            {} as any, // configService - unused by the methods under test
            roleHierarchyMock,
            auditLogMock,
            authServiceMock,
            {} as any, // platformAccess - unused by the methods under test
        );
    });

    describe('hardDeleteUser - pré-contrôle Planning.responsible (audit #1 follow-up)', () => {
        it("bloque la suppression tant que l'utilisateur est responsable d'un planning", async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUserNoPlatforms);
            prismaMock.planning.count.mockResolvedValue(1);

            await expect(service.hardDeleteUser('actor', 'user-1')).rejects.toThrow(ConflictException);
            expect(prismaMock.user.delete).not.toHaveBeenCalled();
        });

        it("autorise la suppression une fois qu'aucun planning ne le désigne plus comme responsable", async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUserNoPlatforms);
            prismaMock.planning.count.mockResolvedValue(0);
            prismaMock.planningEntry.count.mockResolvedValue(0);

            await expect(service.hardDeleteUser('actor', 'user-1')).resolves.toEqual(
                expect.objectContaining({ message: expect.any(String) }),
            );
            expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
        });
    });

    describe('hardDeleteUser - pré-contrôle PlanningEntry.creatorId (audit #5)', () => {
        it("bloque la suppression tant que l'utilisateur est créateur d'au moins un item de planning", async () => {
            prismaMock.user.findUnique.mockResolvedValue(activeUserNoPlatforms);
            prismaMock.planning.count.mockResolvedValue(0);
            prismaMock.planningEntry.count.mockResolvedValue(3);

            await expect(service.hardDeleteUser('actor', 'user-1')).rejects.toThrow(ConflictException);
            expect(prismaMock.user.delete).not.toHaveBeenCalled();
        });
    });

    describe('deleteOwnAccount - step-up TOTP (audit #3)', () => {
        const context = { ipAddress: '203.0.113.1', userAgent: 'jest' };

        it("n'appelle jamais hardDeleteUser (prisma.user.delete) si le step-up TOTP échoue", async () => {
            authServiceMock.verifyStepUpTotp.mockRejectedValue(new UnauthorizedException('Re-authentication failed.'));

            await expect(service.deleteOwnAccount('user-1', '000000', context)).rejects.toThrow(UnauthorizedException);

            expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
            expect(prismaMock.user.delete).not.toHaveBeenCalled();
        });

        it('procède à la suppression une fois le step-up TOTP validé', async () => {
            authServiceMock.verifyStepUpTotp.mockResolvedValue(undefined);
            prismaMock.user.findUnique.mockResolvedValue(activeUserNoPlatforms);
            prismaMock.planning.count.mockResolvedValue(0);
            prismaMock.planningEntry.count.mockResolvedValue(0);

            await service.deleteOwnAccount('user-1', '123456', context);

            expect(authServiceMock.verifyStepUpTotp).toHaveBeenCalledWith('user-1', '123456', context);
            expect(prismaMock.user.delete).toHaveBeenCalledWith({ where: { id: 'user-1' } });
        });
    });
});
