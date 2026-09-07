import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RoleHierarchyService } from './role-hierarchy.service';

/**
 * NOTE: this entire file was previously commented out (`// describe(...)` etc.) - it
 * contributed ZERO real coverage despite being counted as "1 test" for `common/` in
 * `docs/TESTS_COVERAGE_AUDIT.md`. Restored here, with `assertCanGrantRole`'s tests updated to
 * match its current two-rule implementation (hierarchy level AND permission containment - see
 * that method's own doc comment), and new tests added for `assertCanDeleteRole` (audit #13).
 *
 * `RoleHierarchyService` is the single most security-critical piece of the RBAC system - every
 * privilege-escalation guard in the codebase ultimately depends on it being correct.
 */
describe('RoleHierarchyService', () => {
    let service: RoleHierarchyService;
    let prismaMock: any;

    beforeEach(() => {
        prismaMock = {
            userRole: { findMany: jest.fn() },
            role: { findUnique: jest.fn() },
        };
        service = new RoleHierarchyService(prismaMock);
    });

    describe('getBestLevel', () => {
        it('retourne le niveau le plus bas (le plus haut en autorité) parmi plusieurs rôles', async () => {
            prismaMock.userRole.findMany.mockResolvedValue([
                { role: { level: 20 } },
                { role: { level: 5 } },
            ]);
            const level = await service.getBestLevel('user-1');
            expect(level).toBe(5);
        });

        it('retourne null si aucun rôle', async () => {
            prismaMock.userRole.findMany.mockResolvedValue([]);
            const level = await service.getBestLevel('user-1');
            expect(level).toBeNull();
        });
    });

    describe('assertSeniorToTarget', () => {
        it('laisse passer si acteur strictement plus élevé (niveau plus petit)', async () => {
            prismaMock.userRole.findMany
                .mockResolvedValueOnce([{ role: { level: 0 } }]) // acteur
                .mockResolvedValueOnce([{ role: { level: 10 } }]); // cible

            await expect(
                service.assertSeniorToTarget('actor', 'target', 'désactiver'),
            ).resolves.not.toThrow();
        });

        it('bloque si acteur et cible ont le même niveau', async () => {
            prismaMock.userRole.findMany
                .mockResolvedValueOnce([{ role: { level: 10 } }])
                .mockResolvedValueOnce([{ role: { level: 10 } }]);

            await expect(
                service.assertSeniorToTarget('actor', 'target', 'désactiver'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('bloque si acteur a un niveau inférieur (moins élevé) à la cible', async () => {
            prismaMock.userRole.findMany
                .mockResolvedValueOnce([{ role: { level: 20 } }])
                .mockResolvedValueOnce([{ role: { level: 5 } }]);

            await expect(
                service.assertSeniorToTarget('actor', 'target', 'désactiver'),
            ).rejects.toThrow(ForbiddenException);
        });

        it('ne fait rien si acteur == cible (action sur soi-même déléguée ailleurs)', async () => {
            await expect(
                service.assertSeniorToTarget('same-id', 'same-id', 'désactiver'),
            ).resolves.not.toThrow();
            expect(prismaMock.userRole.findMany).not.toHaveBeenCalled();
        });
    });

    describe('assertCanGrantRole', () => {
        it("bloque si le rôle à accorder a un niveau égal ou inférieur (plus fort) à celui de l'acteur", async () => {
            prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 10 } }]);
            prismaMock.role.findUnique.mockResolvedValue({ level: 10, rolePermissions: [] });

            await expect(service.assertCanGrantRole('actor', 'role-id')).rejects.toThrow(
                ForbiddenException,
            );
        });

        it("bloque si le rôle est de niveau plus faible MAIS porte une permission que l'acteur n'a pas (anti-escalade)", async () => {
            // Acteur : niveau 10, ne détient que 'users.read'.
            prismaMock.userRole.findMany.mockResolvedValue([
                {
                    role: {
                        level: 10,
                        rolePermissions: [{ permission: { key: 'users.read' } }],
                    },
                },
            ]);
            // Rôle ciblé : niveau 20 (numériquement plus faible), mais porte 'users.delete'
            // que l'acteur ne possède pas - doit être bloqué malgré le niveau favorable.
            prismaMock.role.findUnique.mockResolvedValue({
                level: 20,
                rolePermissions: [{ permission: { key: 'users.delete' } }],
            });

            await expect(service.assertCanGrantRole('actor', 'role-id')).rejects.toThrow(
                ForbiddenException,
            );
        });

        it("autorise si le rôle est strictement plus faible ET que l'acteur détient déjà toutes ses permissions", async () => {
            const sharedRole = {
                level: 10,
                rolePermissions: [{ permission: { key: 'users.read' } }],
            };
            prismaMock.userRole.findMany.mockResolvedValue([{ role: sharedRole }]);
            prismaMock.role.findUnique.mockResolvedValue({
                level: 20,
                rolePermissions: [{ permission: { key: 'users.read' } }],
            });

            await expect(service.assertCanGrantRole('actor', 'role-id')).resolves.not.toThrow();
        });

        it("lève NotFoundException si le rôle ciblé n'existe pas", async () => {
            prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 10 } }]);
            prismaMock.role.findUnique.mockResolvedValue(null);

            await expect(service.assertCanGrantRole('actor', 'missing-role')).rejects.toThrow(
                NotFoundException,
            );
        });
    });

    describe('assertCanDeleteRole (audit #13)', () => {
        it("bloque si le rôle à supprimer est de rang égal ou supérieur à celui de l'acteur", async () => {
            prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 10 } }]);
            prismaMock.role.findUnique.mockResolvedValue({ id: 'role-id', level: 5 });

            await expect(service.assertCanDeleteRole('actor', 'role-id')).rejects.toThrow(
                ForbiddenException,
            );
        });

        it('bloque si les niveaux sont strictement égaux', async () => {
            prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 10 } }]);
            prismaMock.role.findUnique.mockResolvedValue({ id: 'role-id', level: 10 });

            await expect(service.assertCanDeleteRole('actor', 'role-id')).rejects.toThrow(
                ForbiddenException,
            );
        });

        it("autorise si l'acteur est strictement plus haut rang que le rôle ciblé", async () => {
            prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 0 } }]);
            prismaMock.role.findUnique.mockResolvedValue({ id: 'role-id', level: 10 });

            await expect(service.assertCanDeleteRole('actor', 'role-id')).resolves.not.toThrow();
        });

        it("bloque si l'acteur n'a aucun rôle assigné", async () => {
            prismaMock.userRole.findMany.mockResolvedValue([]);
            prismaMock.role.findUnique.mockResolvedValue({ id: 'role-id', level: 10 });

            await expect(service.assertCanDeleteRole('actor', 'role-id')).rejects.toThrow(
                ForbiddenException,
            );
        });

        it("lève NotFoundException si le rôle ciblé n'existe pas", async () => {
            prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 0 } }]);
            prismaMock.role.findUnique.mockResolvedValue(null);

            await expect(service.assertCanDeleteRole('actor', 'missing-role')).rejects.toThrow(
                NotFoundException,
            );
        });
    });
});
