import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FEATURE_MANIFESTS } from './features.constants';
import { resolveEnabledFeatures } from './feature-selection';
import type { FeatureInfo, FeatureManifest } from './feature.types';

/**
 * Tells the rest of the application which optional features are on.
 *
 * Most of the time you do not need it: a disabled feature's module is never loaded, so its
 * routes, services and jobs simply do not exist. Use it when CORE code needs to behave
 * differently depending on a feature, and prefer an extension point in the core over a check
 * like that whenever you can.
 */
@Injectable()
export class FeaturesService {

    private readonly logger = new Logger(FeaturesService.name);
    private readonly enabled: Set<string>;

    constructor(
        config: ConfigService,
        @Inject(FEATURE_MANIFESTS) private readonly manifests: FeatureManifest[],
    ) {
        this.enabled = resolveEnabledFeatures(manifests, config.get<string>('ENABLED_FEATURES'));

        this.logger.log(
            this.enabled.size > 0
                ? `Optional features enabled: ${[...this.enabled].sort().join(', ')}.`
                : 'No optional feature enabled (base BackOS).',
        );
    }

    isEnabled(name: string): boolean {
        return this.enabled.has(name);
    }

    /** Every installed feature, enabled or not, sorted by name. */
    list(): FeatureInfo[] {
        return this.manifests
            .map((manifest) => ({
                name: manifest.name,
                description: manifest.description,
                enabled: this.enabled.has(manifest.name),
            }))
            .sort((a, b) => a.name.localeCompare(b.name));
    }
}
