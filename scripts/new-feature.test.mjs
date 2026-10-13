import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { render, scaffold, toEnvPrefix, toPascalCase, validateName } from './new-feature.mjs';

/** A fake repository root with the few folders validateName looks at. */
function fakeRoot() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backos-newfeature-'));
    fs.mkdirSync(path.join(root, 'src', 'features'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'users'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src', 'common', 'constants'), { recursive: true });
    fs.writeFileSync(
        path.join(root, 'src', 'common', 'constants', 'permissions.constant.ts'),
        "export const PERMISSIONS = { USERS_READ: 'users.read', AUDIT_READ: 'audit.read' } as const;",
    );
    return root;
}

test('names are converted for code and settings', () => {
    assert.equal(toPascalCase('my-feature'), 'MyFeature');
    assert.equal(toPascalCase('demo-board'), 'DemoBoard');
    assert.equal(toEnvPrefix('demo-board'), 'DEMO_BOARD_');
});

test('validateName accepts a free kebab-case name', () => {
    assert.equal(validateName('my-feature', fakeRoot()), null);
    assert.equal(validateName('demo-board', fakeRoot()), null);
});

test('validateName refuses bad names', () => {
    const root = fakeRoot();
    assert.match(validateName('', root), /Missing name/);
    assert.match(validateName('DemoBoard', root), /kebab-case/);
    assert.match(validateName('1demo', root), /kebab-case/);
    assert.match(validateName('all', root), /reserved/);
});

test('validateName refuses a name that clashes with the base', () => {
    const root = fakeRoot();
    assert.match(validateName('users', root), /part of the base/);
    assert.match(validateName('audit', root), /permission namespace/);
});

test('validateName refuses a feature that already exists', () => {
    const root = fakeRoot();
    fs.mkdirSync(path.join(root, 'src', 'features', 'my-feature'));
    assert.match(validateName('my-feature', root), /already exists/);
});

test('the skeleton uses the name everywhere and keeps the safety rules', () => {
    const files = render('demo-board');

    assert.deepEqual(Object.keys(files).sort(), [
        'README.md',
        'demo-board.controller.ts',
        'demo-board.module.ts',
        'demo-board.service.spec.ts',
        'demo-board.service.ts',
        'feature.spec.ts',
        'feature.ts',
    ]);
    assert.match(files['feature.ts'], /name: 'demo-board'/);
    assert.match(files['feature.ts'], /defaultEnabled: false/);
    assert.match(files['feature.ts'], /DEMO_BOARD_EXAMPLE_LIMIT/);
    assert.match(files['demo-board.controller.ts'], /@RequirePermissions\(featurePermission\('demo-board.read'\)\)/);
    assert.match(files['demo-board.module.ts'], /export class DemoBoardModule/);
});

test('scaffold writes the files, and refuses to overwrite them', () => {
    const root = fakeRoot();
    const created = scaffold('my-feature', root);

    assert.equal(created.length, 7);
    assert.ok(fs.existsSync(path.join(root, 'src', 'features', 'my-feature', 'feature.ts')));
    assert.throws(() => scaffold('my-feature', root), /already exists/);
});
