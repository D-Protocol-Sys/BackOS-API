// import { ForbiddenException } from '@nestjs/common';
// import { RoleHierarchyService } from './role-hierarchy.service';

// describe('RoleHierarchyService', () => {
//     let service: RoleHierarchyService;
//     let prismaMock: any;

//     beforeEach(() => {
//         prismaMock = {
//         userRole: { findMany: jest.fn() },
//         role: { findUnique: jest.fn() },
//         };
//         service = new RoleHierarchyService(prismaMock);
//     });

//     describe('getBestLevel', () => {
//         it('retourne le niveau le plus bas (le plus haut en autorité) parmi plusieurs rôles', async () => {
//         prismaMock.userRole.findMany.mockResolvedValue([
//             { role: { level: 20 } },
//             { role: { level: 5 } },
//         ]);
//         const level = await service.getBestLevel('user-1');
//         expect(level).toBe(5);
//         });

//         it('retourne null si aucun rôle', async () => {
//         prismaMock.userRole.findMany.mockResolvedValue([]);
//         const level = await service.getBestLevel('user-1');
//         expect(level).toBeNull();
//         });
//     });

//     describe('assertSeniorToTarget', () => {
//         it('laisse passer si acteur strictement plus élevé (niveau plus petit)', async () => {
//         prismaMock.userRole.findMany
//             .mockResolvedValueOnce([{ role: { level: 0 } }]) // acteur
//             .mockResolvedValueOnce([{ role: { level: 10 } }]); // cible

//         await expect(
//             service.assertSeniorToTarget('actor', 'target', 'désactiver'),
//         ).resolves.not.toThrow();
//         });

//         it('bloque si acteur et cible ont le même niveau', async () => {
//         prismaMock.userRole.findMany
//             .mockResolvedValueOnce([{ role: { level: 10 } }])
//             .mockResolvedValueOnce([{ role: { level: 10 } }]);

//         await expect(
//             service.assertSeniorToTarget('actor', 'target', 'désactiver'),
//         ).rejects.toThrow(ForbiddenException);
//         });

//         it('bloque si acteur a un niveau inférieur (moins élevé) à la cible', async () => {
//         prismaMock.userRole.findMany
//             .mockResolvedValueOnce([{ role: { level: 20 } }])
//             .mockResolvedValueOnce([{ role: { level: 5 } }]);

//         await expect(
//             service.assertSeniorToTarget('actor', 'target', 'désactiver'),
//         ).rejects.toThrow(ForbiddenException);
//         });

//         it('ne fait rien si acteur == cible (action sur soi-même déléguée ailleurs)', async () => {
//         await expect(
//             service.assertSeniorToTarget('same-id', 'same-id', 'désactiver'),
//         ).resolves.not.toThrow();
//         expect(prismaMock.userRole.findMany).not.toHaveBeenCalled();
//         });
//     });

//     describe('assertCanGrantRole', () => {
//         it('bloque si le rôle à accorder a un niveau égal ou inférieur (plus fort) à celui de l\'acteur', async () => {
//         prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 10 } }]);
//         prismaMock.role.findUnique.mockResolvedValue({ level: 10 });

//         await expect(service.assertCanGrantRole('actor', 'role-id')).rejects.toThrow(
//             ForbiddenException,
//         );
//         });

//         it('autorise si le rôle à accorder est strictement plus faible', async () => {
//         prismaMock.userRole.findMany.mockResolvedValue([{ role: { level: 10 } }]);
//         prismaMock.role.findUnique.mockResolvedValue({ level: 20 });

//         await expect(service.assertCanGrantRole('actor', 'role-id')).resolves.not.toThrow();
//         });
//     });
// });