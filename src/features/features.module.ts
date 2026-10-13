import { DynamicModule, Module } from '@nestjs/common';
import { ConditionalModule } from '@nestjs/config';
import { FEATURE_MANIFESTS } from './features.constants';
import { FeaturesController } from './features.controller';
import { FeaturesService } from './features.service';
import { discoverFeatures } from './feature-registry';
import { isFeatureEnabled } from './feature-selection';
import type { FeatureManifest } from './feature.types';

export interface FeaturesModuleOptions {
    /** Overrides the discovery. For the tests only. */
    manifests?: FeatureManifest[];
}

/**
 * Loads the optional features.
 *
 * Every discovered feature module is wrapped in `ConditionalModule`, which waits until
 * `ConfigModule` has read the environment (including the `.env.<NODE_ENV>` file) and only then
 * decides whether to load it. A disabled feature is therefore not instantiated at all.
 */
@Module({})
export class FeaturesModule {

    static register(options: FeaturesModuleOptions = {}): DynamicModule {

        const manifests = options.manifests ?? discoverFeatures();

        return {
            module: FeaturesModule,
            global: true,
            imports: manifests.map((manifest) =>
                ConditionalModule.registerWhen(manifest.module, (env) =>
                    isFeatureEnabled(manifests, manifest.name, env.ENABLED_FEATURES),
                ),
            ),
            controllers: [FeaturesController],
            providers: [{ provide: FEATURE_MANIFESTS, useValue: manifests }, FeaturesService],
            exports: [FeaturesService],
        };
    }
}
