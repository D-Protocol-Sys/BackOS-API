#!/usr/bin/env node
/**
 * Lists the optional features for the CI. Prints two lines for $GITHUB_OUTPUT:
 *
 *   count=<number of features>
 *   matrix={"include":[{"label":"base","value":""},{"label":"all","value":"all"}, ...]}
 *
 * The matrix is what the "Optional features" job runs the end-to-end boot check on:
 * no feature at all ("base"), every feature together ("all"), and each feature alone.
 * With a single feature, "all" and "only" would be the same, so only "all" is kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function listFeatures(featuresDir = 'src/features') {
    if (!fs.existsSync(featuresDir)) return [];
    return fs
        .readdirSync(featuresDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_') && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
        .filter((name) => fs.existsSync(path.join(featuresDir, name, 'feature.ts')))
        .sort();
}

export function buildMatrix(names) {
    if (names.length === 0) return { include: [] };
    const include = [{ label: 'base', value: '' }, { label: 'all', value: 'all' }];
    if (names.length > 1) for (const name of names) include.push({ label: `only ${name}`, value: name });
    return { include };
}

function main() {
    const names = listFeatures();
    console.log(`count=${names.length}`);
    console.log(`matrix=${JSON.stringify(buildMatrix(names))}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
