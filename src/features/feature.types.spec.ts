import { Module } from '@nestjs/common';
import { assertValidManifest, defineFeature, featureEnvPrefix, FeatureManifest } from './feature.types';

@Module({})
class DemoModule {}

const valid = (overrides: Partial<FeatureManifest> = {}): FeatureManifest => ({
    name: 'demo-board',
    description: 'A demo feature',
    defaultEnabled: false,
    module: DemoModule,
    ...overrides,
});

describe('defineFeature / assertValidManifest', () => {
    it('accepts a valid manifest and freezes it', () => {
        const manifest = defineFeature(
            valid({
                permissions: { 'demo-board.read': 'View boards' },
            }),
        );

        expect(manifest.name).toBe('demo-board');
        expect(Object.isFrozen(manifest)).toBe(true);
    });

    it.each([
        ['an upper-case name', { name: 'DemoBoard' }],
        ['a name starting with a digit', { name: '1demo' }],
        ['a name with a double dash', { name: 'demo--board' }],
        ['the reserved name "all"', { name: 'all' }],
        ['an empty description', { description: '  ' }],
        ['a non-boolean defaultEnabled', { defaultEnabled: 'no' as unknown as boolean }],
        ['a module that is not a class', { module: {} as never }],
    ])('rejects %s', (_label, overrides) => {
        expect(() => assertValidManifest(valid(overrides as Partial<FeatureManifest>))).toThrow(
            /Invalid feature manifest/,
        );
    });

    it('requires permissions to be namespaced with the feature name', () => {
        expect(() => assertValidManifest(valid({ permissions: { 'users.read': 'x' } }))).toThrow(
            /must start with "demo-board\."/,
        );
    });

    it('requires a description for every permission', () => {
        expect(() => assertValidManifest(valid({ permissions: { 'demo-board.read': '' } }))).toThrow(
            /needs a description/,
        );
    });

    it('requires environment variables to carry the feature prefix', () => {
        expect(() => assertValidManifest(valid({ env: { PORT: {} as never } }))).toThrow(/DEMO_BOARD_/);
        expect(() => assertValidManifest(valid({ requiredEnv: ['TOKEN'] }))).toThrow(/DEMO_BOARD_/);
    });

    it('builds the environment prefix from the name', () => {
        expect(featureEnvPrefix('my-feature')).toBe('MY_FEATURE_');
        expect(featureEnvPrefix('demo-board')).toBe('DEMO_BOARD_');
    });
});
