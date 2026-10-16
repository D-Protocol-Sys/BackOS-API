import { PermissionsSyncService } from './permissions-sync.service';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import * as registry from '../features/feature-registry';

describe('PermissionsSyncService - optional features', () => {
    const prisma = {
        permission: {
            upsert: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
            findMany: jest.fn().mockResolvedValue([]),
        },
        role: { findUnique: jest.fn().mockResolvedValue(null) },
        rolePermission: { createMany: jest.fn() },
    };

    type UpsertArgs = { where: { key: string }; create: { description: string } };
    type DeleteArgs = { where: { key: { notIn: string[] } } };

    const upsertCalls = () => prisma.permission.upsert.mock.calls as unknown as Array<[UpsertArgs]>;
    const deleteCalls = () => prisma.permission.deleteMany.mock.calls as unknown as Array<[DeleteArgs]>;

    afterEach(() => jest.clearAllMocks());

    it('keeps the permissions of installed features in the catalog', async () => {
        jest.spyOn(registry, 'collectFeaturePermissions').mockReturnValue({
            'notes.read': 'Read notes',
            'notes.write': 'Write notes',
        });

        await new PermissionsSyncService(prisma as never).onApplicationBootstrap();

        const upserted = upsertCalls().map(([args]) => args.where.key);
        expect(upserted).toEqual(expect.arrayContaining([...Object.values(PERMISSIONS), 'notes.read', 'notes.write']));

        const upsertNotesRead = upsertCalls().find(([args]) => args.where.key === 'notes.read');
        expect(upsertNotesRead?.[0].create.description).toBe('Read notes');
    });

    it('never purges a feature permission, so switching a feature off does not erase role assignments', async () => {
        jest.spyOn(registry, 'collectFeaturePermissions').mockReturnValue({ 'notes.read': 'Read notes' });

        await new PermissionsSyncService(prisma as never).onApplicationBootstrap();

        const { where } = deleteCalls()[0][0];
        expect(where.key.notIn).toContain('notes.read');
    });

    it('still purges a permission that no longer exists anywhere in the code', async () => {
        jest.spyOn(registry, 'collectFeaturePermissions').mockReturnValue({});

        await new PermissionsSyncService(prisma as never).onApplicationBootstrap();

        const { where } = deleteCalls()[0][0];
        expect(where.key.notIn).not.toContain('notes.read');
    });
});
