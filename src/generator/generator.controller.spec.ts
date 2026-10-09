import { NotFoundException } from '@nestjs/common';
import { GeneratorController } from './generator.controller';

/**
 * SEC-003: GET /platforms/:platformId/generations/:generationId used to return ANY generation
 * (logs included) as long as the caller could read the generations of the platform in the URL.
 */
describe('GeneratorController.getGeneration (audit SEC-003)', () => {
    let controller: GeneratorController;
    let prismaMock: any;
    let generationsMock: any;

    beforeEach(() => {
        prismaMock = { platform: { findUnique: jest.fn().mockResolvedValue({ id: 'platform-A', ownerId: 'owner' }) } };
        generationsMock = { getById: jest.fn() };
        controller = new GeneratorController(
            {} as any, // queue
            generationsMock,
            prismaMock,
            {} as any, // cancellationRegistry
            {} as any, // runtimeManager
            {} as any, // apiManifest
            {} as any, // access
            { log: jest.fn().mockResolvedValue(undefined) } as any, // auditLog
        );
        jest.spyOn(controller as any, 'assertCanReadGenerations').mockResolvedValue(undefined);
    });

    it("renvoie la génération quand elle appartient à la plateforme de l'URL", async () => {
        generationsMock.getById.mockResolvedValue({ id: 'gen-1', platformId: 'platform-A' });
        await expect(controller.getGeneration({ userId: 'owner' } as any, 'platform-A', 'gen-1')).resolves.toEqual(
            expect.objectContaining({ id: 'gen-1' }),
        );
    });

    it("refuse (404) la génération d'une AUTRE plateforme", async () => {
        generationsMock.getById.mockResolvedValue({ id: 'gen-2', platformId: 'platform-B', logs: 'secret logs' });
        await expect(controller.getGeneration({ userId: 'owner' } as any, 'platform-A', 'gen-2')).rejects.toThrow(
            NotFoundException,
        );
    });
});
