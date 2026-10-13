import type { FeatureManifest } from './feature.types';

/** In `ENABLED_FEATURES`, enables every installed feature. */
export const ALL_FEATURES_TOKEN = 'all';

export class UnknownFeatureError extends Error {
    constructor(readonly unknown: string[], readonly installed: string[]) {
        super(
            `Unknown feature(s) in ENABLED_FEATURES: ${unknown.map((name) => `"${name}"`).join(', ')}. ` +
            (installed.length > 0
                ? `Installed features: ${installed.join(', ')}.`
                : 'No optional feature is installed.'),
        );
        this.name = 'UnknownFeatureError';
    }
}

/** Splits the raw `ENABLED_FEATURES` value: separators are commas and/or spaces, case-insensitive. */
export function parseFeatureList(raw: string | undefined | null): string[] {
    return (raw ?? '')
        .split(/[\s,]+/)
        .map((token) => token.trim().toLowerCase())
        .filter(Boolean);
}

/**
 * Works out which features are on.
 *
 * Start from the features that are enabled by default, then apply the tokens of
 * `ENABLED_FEATURES` from left to right:
 *   - `name`   turns a feature on,
 *   - `-name`  turns a feature off (useful for one that is on by default),
 *   - `all`    turns every installed feature on.
 *
 * It is additive on purpose: when a feature later becomes enabled by default, people who listed
 * other features are not silently switched off.
 *
 * Throws `UnknownFeatureError` for a name that is not installed, so a typo stops the boot.
 */
export function resolveEnabledFeatures(manifests: FeatureManifest[], raw: string | undefined | null): Set<string> {
    const installed = new Set(manifests.map((manifest) => manifest.name));
    const enabled = new Set(manifests.filter((manifest) => manifest.defaultEnabled).map((manifest) => manifest.name));
    const unknown: string[] = [];

    for (const token of parseFeatureList(raw)) {
        if (token === ALL_FEATURES_TOKEN) {
            installed.forEach((name) => enabled.add(name));
            continue;
        }

        const disable = token.startsWith('-');
        const name = disable ? token.slice(1) : token;

        if (!installed.has(name)) {
            unknown.push(token);
            continue;
        }

        if (disable) enabled.delete(name);
        else enabled.add(name);
    }

    if (unknown.length > 0) throw new UnknownFeatureError(unknown, [...installed].sort());

    return enabled;
}

export function isFeatureEnabled(manifests: FeatureManifest[], name: string, raw: string | undefined | null): boolean {
    return resolveEnabledFeatures(manifests, raw).has(name);
}
