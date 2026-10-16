import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectFeaturePermissions, discoverFeatures, resetFeatureCache } from './feature-registry';

/** Writes a fake `src/features` folder: `{ folder: { file: content } }`. */
function fixture(tree: Record<string, Record<string, string>>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backos-features-'));
    for (const [folder, files] of Object.entries(tree)) {
        fs.mkdirSync(path.join(root, folder), { recursive: true });
        for (const [file, content] of Object.entries(files)) {
            fs.writeFileSync(path.join(root, folder, file), content);
        }
    }
    return root;
}

const manifestFile = (name: string, extra = '') => `
    class ${name.replace(/[^a-z]/gi, '')}Module {}
    exports.default = {
        name: '${name}',
        description: 'Fixture ${name}',
        defaultEnabled: false,
        module: ${name.replace(/[^a-z]/gi, '')}Module,
        ${extra}
    };
`;

describe('discoverFeatures', () => {
    const created: string[] = [];
    const make = (tree: Record<string, Record<string, string>>) => {
        const dir = fixture(tree);
        created.push(dir);
        return dir;
    };

    beforeEach(() => resetFeatureCache());

    afterAll(() => {
        for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('finds every folder that holds a feature.js, sorted by name', () => {
        const dir = make({
            zeta: { 'feature.js': manifestFile('zeta') },
            alpha: { 'feature.js': manifestFile('alpha') },
        });

        expect(discoverFeatures(dir).map((feature) => feature.name)).toEqual(['alpha', 'zeta']);
    });

    it('ignores folders starting with "_" or "." and folders with no source code', () => {
        const dir = make({
            alpha: { 'feature.js': manifestFile('alpha') },
            _shared: { 'helpers.js': 'module.exports = {};' },
            '.cache': { 'x.js': 'module.exports = {};' },
            notes: { 'README.md': '# only documentation' },
        });

        expect(discoverFeatures(dir).map((feature) => feature.name)).toEqual(['alpha']);
    });

    it('refuses a folder that has source code but no manifest', () => {
        const dir = make({ orphan: { 'orphan.service.js': 'module.exports = {};' } });

        expect(() => discoverFeatures(dir)).toThrow(/Feature folder "orphan" has no feature\.ts/);
    });

    it('refuses a manifest that is not the default export', () => {
        const dir = make({ alpha: { 'feature.js': 'exports.nothing = 1;' } });

        expect(() => discoverFeatures(dir)).toThrow(/default export/);
    });

    it('refuses a name that differs from the folder name', () => {
        const dir = make({ alpha: { 'feature.js': manifestFile('beta') } });

        expect(() => discoverFeatures(dir)).toThrow(/identical/);
    });

    it('refuses an invalid manifest', () => {
        const dir = make({
            alpha: { 'feature.js': manifestFile('alpha').replace("description: 'Fixture alpha'", "description: ''") },
        });

        expect(() => discoverFeatures(dir)).toThrow(/description/);
    });

    it('refuses a permission that is not namespaced with the feature name', () => {
        // `users.read` is a core permission and does not start with "alpha." either.
        const dir = make({
            alpha: { 'feature.js': manifestFile('alpha', "permissions: { 'alpha.read': 'x', 'users.read': 'y' },") },
        });

        expect(() => discoverFeatures(dir)).toThrow(/must start with "alpha\./);
    });

    it('refuses a feature named like a core permission namespace', () => {
        // A feature called "backup" would declare "backup.manage", which the core already owns.
        const dir = make({
            backup: { 'feature.js': manifestFile('backup', "permissions: { 'backup.manage': 'x' },") },
        });

        expect(() => discoverFeatures(dir)).toThrow(/already exists in the core/);
    });

    it('collects the permissions of every feature', () => {
        const dir = make({
            alpha: { 'feature.js': manifestFile('alpha', "permissions: { 'alpha.read': 'Read alpha' },") },
            beta: { 'feature.js': manifestFile('beta', "permissions: { 'beta.write': 'Write beta' },") },
        });

        expect(collectFeaturePermissions(discoverFeatures(dir))).toEqual({
            'alpha.read': 'Read alpha',
            'beta.write': 'Write beta',
        });
    });

    it('is valid for the real src/features folder', () => {
        // A guard for contributors: a broken feature fails here, with an explicit message.
        const features = discoverFeatures();
        const names = features.map((feature) => feature.name);

        expect(new Set(names).size).toBe(names.length);

        // New features must be OFF by default, so that the base BackOS behaves exactly as before.
        // When a maintainer decides that a feature "graduates" to the base, list it here.
        const graduated: string[] = [];
        for (const feature of features) {
            if (!graduated.includes(feature.name)) expect(feature.defaultEnabled).toBe(false);
        }
    });
});
