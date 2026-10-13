import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildMatrix, listFeatures } from './list-features.mjs';

function fixture(folders) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backos-listfeatures-'));
    for (const [folder, files] of Object.entries(folders)) {
        fs.mkdirSync(path.join(dir, folder), { recursive: true });
        for (const file of files) fs.writeFileSync(path.join(dir, folder, file), '');
    }
    return dir;
}

test('lists the folders that hold a feature.ts, sorted', () => {
    const dir = fixture({
        zeta: ['feature.ts'],
        alpha: ['feature.ts'],
        _shared: ['feature.ts'],
        notes: ['README.md'],
    });

    assert.deepEqual(listFeatures(dir), ['alpha', 'zeta']);
});

test('an unknown folder means no feature', () => {
    assert.deepEqual(listFeatures('/does/not/exist'), []);
});

test('no feature: nothing to run', () => {
    assert.deepEqual(buildMatrix([]), { include: [] });
});

test('one feature: base and all', () => {
    assert.deepEqual(buildMatrix(['alpha']).include.map((s) => s.label), ['base', 'all']);
});

test('several features: base, all, and each alone', () => {
    const { include } = buildMatrix(['alpha', 'beta']);

    assert.deepEqual(include.map((s) => s.label), ['base', 'all', 'only alpha', 'only beta']);
    assert.deepEqual(include.map((s) => s.value), ['', 'all', 'alpha', 'beta']);
});
