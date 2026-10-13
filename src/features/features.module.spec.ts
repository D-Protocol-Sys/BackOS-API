import { Injectable, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { FeaturesController } from './features.controller';
import { FeaturesModule } from './features.module';
import { FeaturesService } from './features.service';
import { FeatureManifest } from './feature.types';

@Injectable()
class AlphaService {}

@Module({ providers: [AlphaService], exports: [AlphaService] })
class AlphaModule {}

@Injectable()
class BetaService {}

@Module({ providers: [BetaService], exports: [BetaService] })
class BetaModule {}

const alpha: FeatureManifest = { name: 'alpha', description: 'Alpha feature', defaultEnabled: false, module: AlphaModule };
const beta: FeatureManifest = { name: 'beta', description: 'Beta feature', defaultEnabled: true, module: BetaModule };

describe('FeaturesModule', () => {

    const original = process.env.ENABLED_FEATURES;
    let app: TestingModule | undefined;

    /** Boots a Nest application whose environment holds `enabled` (undefined = not set). */
    async function boot(enabled: string | undefined): Promise<TestingModule> {
        if (enabled === undefined) delete process.env.ENABLED_FEATURES;
        else process.env.ENABLED_FEATURES = enabled;

        app = await Test.createTestingModule({
            imports: [
                ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
                FeaturesModule.register({ manifests: [alpha, beta] }),
            ],
        }).compile();

        return app;
    }

    const has = (moduleRef: TestingModule, token: new () => unknown) => {
        try {
            moduleRef.get(token, { strict: false });
            return true;
        } catch {
            return false;
        }
    };

    afterEach(async () => {
        await app?.close();
        app = undefined;
        if (original === undefined) delete process.env.ENABLED_FEATURES;
        else process.env.ENABLED_FEATURES = original;
    });

    it('loads only the features enabled by default when nothing is set', async () => {
        const moduleRef = await boot(undefined);

        expect(has(moduleRef, AlphaService)).toBe(false);
        expect(has(moduleRef, BetaService)).toBe(true);
    });

    it('loads a feature that is named in ENABLED_FEATURES', async () => {
        const moduleRef = await boot('alpha');

        expect(has(moduleRef, AlphaService)).toBe(true);
        expect(has(moduleRef, BetaService)).toBe(true);
    });

    it('loads nothing optional when a default feature is switched off', async () => {
        const moduleRef = await boot('-beta');

        expect(has(moduleRef, AlphaService)).toBe(false);
        expect(has(moduleRef, BetaService)).toBe(false);
    });

    it('loads every feature with "all"', async () => {
        const moduleRef = await boot('all');

        expect(has(moduleRef, AlphaService)).toBe(true);
        expect(has(moduleRef, BetaService)).toBe(true);
    });

    it('refuses to boot with an unknown feature name', async () => {
        await expect(boot('alpah')).rejects.toThrow(/Unknown feature\(s\) in ENABLED_FEATURES: "alpah"/);
    });

    it('tells the rest of the application which features are on', async () => {
        const moduleRef = await boot('alpha');
        const features = moduleRef.get(FeaturesService);

        expect(features.isEnabled('alpha')).toBe(true);
        expect(features.isEnabled('beta')).toBe(true);
        expect(features.isEnabled('unknown')).toBe(false);
    });

    it('lists every installed feature, enabled or not, for the front end', async () => {
        const moduleRef = await boot(undefined);

        expect(moduleRef.get(FeaturesController).list()).toEqual({
            features: [
                { name: 'alpha', description: 'Alpha feature', enabled: false },
                { name: 'beta', description: 'Beta feature', enabled: true },
            ],
        });
    });
});
