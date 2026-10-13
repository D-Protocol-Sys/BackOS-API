import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { collectFeaturePermissions, discoverFeatures } from '../src/features/feature-registry';
import { resolveEnabledFeatures } from '../src/features/feature-selection';
import { FeaturesService } from '../src/features/features.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapOwnerSession } from './helpers/auth.helper';

/**
 * Boots the REAL application with the ENABLED_FEATURES of the environment (the CI runs this file
 * once with no feature, once with all of them, and once per feature - see the "Optional
 * features" job of .github/workflows/ci.yml) and checks that the optional features behave:
 * the right ones are loaded, their permissions are in the catalog, and the front end can ask
 * which ones are on.
 *
 * It does nothing useful until the first feature exists, and the CI does not run it before then.
 */
describe(`Optional features (ENABLED_FEATURES="${process.env.ENABLED_FEATURES ?? ''}")`, () => {
    let app: INestApplication;
    let accessToken: string;

    const manifests = discoverFeatures();
    const expected = resolveEnabledFeatures(manifests, process.env.ENABLED_FEATURES);

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        app = moduleRef.createNestApplication();
        await app.init();

        ({ accessToken } = await bootstrapOwnerSession(app));
    });

    afterAll(async () => {
        await app.close();
    });

    it('loads exactly the features that ENABLED_FEATURES asks for', () => {
        const features = app.get(FeaturesService);

        for (const manifest of manifests) {
            expect({ name: manifest.name, enabled: features.isEnabled(manifest.name) }).toEqual({
                name: manifest.name,
                enabled: expected.has(manifest.name),
            });
        }
    });

    it('keeps the permissions of every installed feature in the catalog, switched on or not', async () => {
        const keys = Object.keys(collectFeaturePermissions(manifests));
        if (keys.length === 0) return;

        const rows = await app.get(PrismaService).permission.findMany({ where: { key: { in: keys } } });

        expect(rows.map((row) => row.key).sort()).toEqual([...keys].sort());
    });

    it('requires a signed-in user to list the features', async () => {
        await request(app.getHttpServer()).get('/api/features').expect(401);
    });

    it('tells a signed-in user which features are on', async () => {
        const res = await request(app.getHttpServer())
            .get('/api/features')
            .set('Authorization', `Bearer ${accessToken}`)
            .expect(200);

        const body = res.body as { features: unknown[] };

        expect(body.features).toEqual(
            manifests
                .map((manifest) => ({
                    name: manifest.name,
                    description: manifest.description,
                    enabled: expected.has(manifest.name),
                }))
                .sort((a, b) => a.name.localeCompare(b.name)),
        );
    });
});
