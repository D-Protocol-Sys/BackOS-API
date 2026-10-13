import * as Joi from 'joi';
import { discoverFeatures } from './feature-registry';
import { resolveEnabledFeatures, UnknownFeatureError } from './feature-selection';
import type { FeatureManifest } from './feature.types';

const isBlank = (value: unknown): boolean =>
    value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

export interface FeatureEnvResult {
    /** Values of the features' own variables, with their Joi defaults applied. */
    value: Record<string, unknown>;
    /** Human-readable problems. Empty when everything is fine. */
    errors: string[];
}

/**
 * The "features" part of the environment validation, called from `env.validation.ts` once the
 * core variables have been validated:
 *
 *   1. `ENABLED_FEATURES` must only name installed features;
 *   2. the variables declared by the features (`manifest.env`) must be valid, defaults applied;
 *   3. the variables a feature lists in `requiredEnv` must be set, but only if it is enabled.
 *
 * Pure on purpose (no Nest, no globals besides the discovery cache) so that it can be unit tested.
 */
export function validateFeatureEnv(
    env: Record<string, unknown>,
    manifests: FeatureManifest[] = discoverFeatures(),
): FeatureEnvResult {
    const errors: string[] = [];

    let enabled = new Set<string>();
    try {
        enabled = resolveEnabledFeatures(manifests, env.ENABLED_FEATURES as string | undefined);
    } catch (error) {
        if (error instanceof UnknownFeatureError) errors.push(error.message);
        else throw error;
    }

    const rules: Joi.PartialSchemaMap = {};
    for (const manifest of manifests) Object.assign(rules, manifest.env ?? {});

    let value: Record<string, unknown> = {};
    if (Object.keys(rules).length > 0) {
        const result = Joi.object(rules).unknown(true).validate(env, { abortEarly: false });
        if (result.error) errors.push(...result.error.details.map((detail) => detail.message));
        else {
            // Only keep the features' own keys: the core ones were already validated and are
            // merged back by the caller.
            const validated = result.value as Record<string, unknown>;
            value = Object.fromEntries(Object.keys(rules).filter((key) => key in validated).map((key) => [key, validated[key]]));
        }
    }

    for (const manifest of manifests) {
        if (!enabled.has(manifest.name)) continue;
        for (const key of manifest.requiredEnv ?? []) {
            if (isBlank(env[key])) {
                errors.push(`Feature "${manifest.name}" is enabled but ${key} is not set.`);
            }
        }
    }

    return { value, errors };
}
