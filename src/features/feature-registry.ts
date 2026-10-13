import * as fs from 'fs';
import * as path from 'path';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { assertValidManifest, FeatureManifest } from './feature.types';

const MANIFEST_FILE = /^feature\.(js|ts)$/;
const SOURCE_FILE = /\.(js|ts)$/;
const DECLARATION_FILE = /\.d\.ts$/;

let cache: FeatureManifest[] | null = null;

/**
 * Finds every feature by convention: each sub-folder of `src/features/` (`dist/features/` once
 * built) that contains a `feature.ts` is a feature. Nothing has to be registered anywhere else,
 * which is what makes adding a feature a matter of adding files, never of editing shared ones.
 *
 * The result is cached for the default folder. `dir` is only overridden by the tests.
 */
export function discoverFeatures(dir: string = __dirname): FeatureManifest[] {
    const useCache = dir === __dirname;
    if (useCache && cache) return cache;

    const manifests: FeatureManifest[] = [];
    const coreKeys = new Set<string>(Object.values(PERMISSIONS));
    const seenPermissions = new Map<string, string>();

    const folders = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .sort();

    for (const folder of folders) {
        const folderPath = path.join(dir, folder);
        const files = fs.readdirSync(folderPath);

        if (!files.some((file) => MANIFEST_FILE.test(file))) {
            // A folder of helper code without a manifest is almost certainly a mistake.
            if (files.some((file) => SOURCE_FILE.test(file) && !DECLARATION_FILE.test(file))) {
                throw new Error(
                    `Feature folder "${folder}" has no feature.ts. ` +
                    'Every sub-folder of src/features/ must declare its manifest there ' +
                    '(prefix the folder with "_" if it only holds shared helper code).',
                );
            }
            continue;
        }

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const loaded = require(path.join(folderPath, 'feature')) as
            | { default?: FeatureManifest; feature?: FeatureManifest }
            | undefined;
        const manifest = loaded?.default ?? loaded?.feature;
        if (!manifest) {
            throw new Error(`src/features/${folder}/feature.ts must export its manifest as the default export.`);
        }

        assertValidManifest(manifest, `manifest of src/features/${folder}`);

        if (manifest.name !== folder) {
            throw new Error(
                `The manifest in src/features/${folder}/feature.ts is named "${manifest.name}": ` +
                'the feature name and its folder name must be identical.',
            );
        }

        for (const key of Object.keys(manifest.permissions ?? {})) {
            if (coreKeys.has(key)) {
                throw new Error(`Feature "${manifest.name}" declares permission "${key}", which already exists in the core.`);
            }
            const owner = seenPermissions.get(key);
            if (owner) {
                throw new Error(`Permission "${key}" is declared by both "${owner}" and "${manifest.name}".`);
            }
            seenPermissions.set(key, manifest.name);
        }

        manifests.push(manifest);
    }

    if (useCache) cache = manifests;
    return manifests;
}

/** Forgets the cached discovery. For the tests only. */
export function resetFeatureCache(): void {
    cache = null;
}

/**
 * The permissions of EVERY discovered feature, enabled or not, as `{ key: description }`.
 * See `FeatureManifest.permissions` for why disabled features are included.
 */
export function collectFeaturePermissions(manifests: FeatureManifest[] = discoverFeatures()): Record<string, string> {
    const permissions: Record<string, string> = {};
    for (const manifest of manifests) Object.assign(permissions, manifest.permissions ?? {});
    return permissions;
}
