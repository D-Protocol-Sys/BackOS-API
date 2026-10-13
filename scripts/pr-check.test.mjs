import assert from 'node:assert/strict';
import test from 'node:test';
import {
    checkBranches,
    checkPullRequest,
    featureSignals,
    MARKER,
    newDependencies,
    parseDeclaredTypes,
    parseFilesNdjson,
    renderComment,
} from './pr-check.mjs';

const body = (type) => `## Type of change
- [${type === 'fix' ? 'x' : ' '}] Fix <!-- type:fix -->
- [${type === 'improvement' ? 'x' : ' '}] Improvement <!-- type:improvement -->
- [${type === 'feature' ? 'x' : ' '}] New feature <!-- type:feature -->
- [${type === 'docs' ? 'x' : ' '}] Documentation <!-- type:docs -->
`;

const file = (filename, status = 'modified', patch = '') => ({ filename, status, patch });

const newFeatureFiles = (name, manifestPatch = "+    defaultEnabled: false,") => [
    file(`src/features/${name}/feature.ts`, 'added', manifestPatch),
    file(`src/features/${name}/${name}.module.ts`, 'added'),
    file(`src/features/${name}/feature.spec.ts`, 'added'),
];

test('reads the ticked type', () => {
    assert.deepEqual(parseDeclaredTypes(body('feature')), ['feature']);
    assert.deepEqual(parseDeclaredTypes(body('docs')), ['docs']);
    assert.deepEqual(parseDeclaredTypes(body(null)), []);
    assert.deepEqual(parseDeclaredTypes('- [X] Improvement <!-- type:improvement -->'), ['improvement']);
    assert.deepEqual(parseDeclaredTypes(undefined), []);
});

test('reads the list of files given by the GitHub API', () => {
    const text = '{"filename":"a.ts","status":"added","patch":"+x"}\n\n{"filename":"b.ts","status":"modified"}\n';
    assert.deepEqual(parseFilesNdjson(text).map((f) => f.filename), ['a.ts', 'b.ts']);
});

test('a type must be ticked, and only one', () => {
    assert.match(checkPullRequest({ body: '', files: [] }).errors[0], /Tick the type/);

    const both = '- [x] a <!-- type:fix -->\n- [x] b <!-- type:feature -->';
    assert.match(checkPullRequest({ body: both, files: [] }).errors[0], /only one type/);
});

test('an automation (Dependabot) needs no template: its pull request is an improvement', () => {
    const result = checkPullRequest({ body: '', files: [file('package.json', 'modified', '-    "joi": "^18.2.3",\n+    "joi": "^18.3.0",')], bot: true });

    assert.deepEqual(result.errors, []);
    assert.equal(result.kind, 'improvement');
    assert.deepEqual(result.warnings, []);
});

test('an improvement that only adds tests is fine', () => {
    const result = checkPullRequest({
        body: body('improvement'),
        files: [file('src/users/users.service.spec.ts', 'added'), file('src/audit/audit.service.spec.ts', 'added')],
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.labels, ['type: improvement']);
});

test('an improvement that looks like a feature is flagged, not refused', () => {
    const result = checkPullRequest({
        body: body('improvement'),
        files: [
            file('prisma/migrations/20261011_boards/migration.sql', 'added'),
            file('src/boards/boards.module.ts', 'added'),
            file('src/boards/boards.controller.ts', 'added'),
        ],
    });

    assert.deepEqual(result.errors, []);
    assert.match(result.warnings[0], /adds a database migration, adds a Nest module, adds a controller/);
    assert.ok(result.labels.includes('needs-type-review'));
});

test('an improvement may not add a src/features folder', () => {
    const result = checkPullRequest({ body: body('improvement'), files: newFeatureFiles('my-feature') });

    assert.match(result.errors[0], /new feature\. Tick "New feature"/);
});

test('a valid new feature passes', () => {
    const result = checkPullRequest({
        body: body('feature'),
        files: [...newFeatureFiles('my-feature'), file('docs/FEATURES.md'), file('prisma/migrations/x/migration.sql', 'added')],
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.newFeatures, ['my-feature']);
    assert.deepEqual(result.labels, ['type: feature']);
});

test('a new feature needs a manifest, a test, and must be off by default', () => {
    const noManifest = checkPullRequest({
        body: body('feature'),
        files: [file('src/features/my-feature/my-feature.module.ts', 'added'), file('src/features/my-feature/a.spec.ts', 'added')],
    });
    assert.match(noManifest.errors[0], /no feature\.ts/);

    const noTest = checkPullRequest({
        body: body('feature'),
        files: [file('src/features/my-feature/feature.ts', 'added', '+    defaultEnabled: false,')],
    });
    assert.match(noTest.errors[0], /no test/);

    const onByDefault = checkPullRequest({
        body: body('feature'),
        files: newFeatureFiles('my-feature', '+    defaultEnabled: true,'),
    });
    assert.match(onByDefault.errors[0], /off by default/);
});

test('declaring a feature without adding a feature folder is an error', () => {
    const result = checkPullRequest({
        body: body('feature'),
        files: [file('src/users/users.service.ts')],
        existingFeatures: ['my-feature'],
    });

    assert.match(result.errors[0], /adds no new src\/features/);
});

test('a feature that edits the base is flagged', () => {
    const result = checkPullRequest({
        body: body('feature'),
        files: [...newFeatureFiles('my-feature'), file('src/users/users.service.ts'), file('src/app.module.ts')],
    });

    assert.deepEqual(result.errors, []);
    assert.match(result.warnings[0], /`src\/users\/users\.service\.ts`, `src\/app\.module\.ts`/);
    assert.ok(result.labels.includes('touches-base'));
});

test('adding a file to a feature that already exists is not a new feature', () => {
    const result = checkPullRequest({
        body: body('improvement'),
        files: [file('src/features/my-feature/export.service.ts', 'added')],
        existingFeatures: ['my-feature'],
    });

    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.newFeatures, []);
});

test('enabling an existing feature by default needs a maintainer', () => {
    const result = checkPullRequest({
        body: body('improvement'),
        files: [file('src/features/my-feature/feature.ts', 'modified', '-    defaultEnabled: false,\n+    defaultEnabled: true,')],
        existingFeatures: ['my-feature'],
    });

    assert.deepEqual(result.errors, []);
    assert.ok(result.labels.includes('needs-maintainer-decision'));
});

test('documentation that changes code is flagged', () => {
    const ok = checkPullRequest({ body: body('docs'), files: [file('docs/FEATURES.md'), file('README.md')] });
    assert.deepEqual(ok.warnings, []);

    const odd = checkPullRequest({ body: body('docs'), files: [file('docs/FEATURES.md'), file('src/app.module.ts')] });
    assert.match(odd.warnings[0], /not documentation/);
});

test('changes to the workflows and scripts are labelled for the owners', () => {
    const result = checkPullRequest({ body: body('improvement'), files: [file('.github/workflows/ci.yml')] });

    assert.ok(result.labels.includes('infra'));
    assert.match(result.warnings[0], /owner/);
});

test('a new dependency is told apart from a version bump', () => {
    const patch = [
        '@@ -10,3 +10,4 @@',
        '-    "joi": "^18.2.3",',
        '+    "joi": "^18.3.0",',
        '+    "some-new-package": "^1.0.0",',
        '+    "build": "nest build",',
    ].join('\n');

    assert.deepEqual(newDependencies(patch), ['some-new-package']);
    assert.deepEqual(featureSignals([file('package.json', 'modified', patch)]), ['adds dependencies (some-new-package)']);
});

test('new environment variables and database models are signals', () => {
    const signals = featureSignals([
        file('src/config/env.validation.ts', 'modified', '+    SOME_NEW_VAR: Joi.string().optional(),'),
        file('prisma/schema.prisma', 'modified', '+model Board {\n+  id String @id\n+}'),
    ]);

    assert.deepEqual(signals, ['adds database models', 'adds environment variables']);
});

test('the comment starts with the marker and lists the problems', () => {
    const result = checkPullRequest({ body: '', files: [] });
    const comment = renderComment(result);

    assert.ok(comment.startsWith(MARKER));
    assert.match(comment, /To fix before this pull request can be merged/);
    assert.match(renderComment(checkPullRequest({ body: body('docs'), files: [file('docs/a.md')] })), /Everything is consistent/);
});

const branches = (overrides = {}) => ({
    base: 'main',
    headRef: 'feature/x',
    headRepo: 'me/backos',
    baseRepo: 'me/backos',
    ...overrides,
});

test('a pull request into develop follows the normal rules', () => {
    assert.deepEqual(checkBranches(branches({ base: 'develop' })), { release: false, errors: [] });

    const result = checkPullRequest({
        body: body('improvement'),
        files: [file('src/users/users.service.spec.ts', 'added')],
        branches: branches({ base: 'develop' }),
    });
    assert.deepEqual(result.errors, []);
});

test('develop into main is a release: no type is required', () => {
    const result = checkPullRequest({
        body: '',
        files: [file('src/anything.ts'), file('prisma/migrations/x/migration.sql', 'added')],
        branches: branches({ headRef: 'develop' }),
    });

    assert.equal(result.kind, 'release');
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.labels, ['release']);
    assert.match(renderComment(result), /Release \(develop to main\)/);
});

test('a contributor must not target main', () => {
    const result = checkPullRequest({
        body: body('improvement'),
        files: [file('src/users/users.service.spec.ts', 'added')],
        branches: branches({ headRef: 'my-change', headRepo: 'contributor/backos' }),
    });

    assert.match(result.errors[0], /targets `main`.*must target `develop`/);
});

test('a fork branch named develop is not a release', () => {
    const result = checkPullRequest({
        body: body('improvement'),
        files: [],
        branches: branches({ headRef: 'develop', headRepo: 'contributor/backos' }),
    });

    assert.match(result.errors[0], /must target `develop`/);
});

test('a hotfix branch of the repository may target main, with the usual checks', () => {
    const ok = checkPullRequest({
        body: body('fix'),
        files: [file('src/users/users.service.ts')],
        branches: branches({ headRef: 'hotfix/login' }),
    });
    assert.deepEqual(ok.errors, []);
    assert.equal(ok.kind, 'fix');

    const noType = checkPullRequest({ body: '', files: [], branches: branches({ headRef: 'hotfix/login' }) });
    assert.match(noType.errors[0], /Tick the type/);
});

test('the branch names are configurable', () => {
    const result = checkBranches({
        base: 'production', headRef: 'staging', headRepo: 'me/r', baseRepo: 'me/r',
        release: 'production', integration: 'staging',
    });

    assert.equal(result.release, true);
});
