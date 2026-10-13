#!/usr/bin/env node
/**
 * Checks that a pull request is what it says it is: an improvement, a fix, documentation or a
 * NEW FEATURE (optional, off by default, in src/features/<name>/).
 *
 * It reads the type the author ticked in the pull request template and the list of files the
 * pull request changes, and reports:
 *   - errors   (the pull request is inconsistent: the workflow fails),
 *   - warnings (it looks suspicious: a maintainer decides),
 *   - labels   (to apply to the pull request).
 *
 * It only ever READS data (the description and the list of files given by the GitHub API): it
 * never runs code from the pull request, so it is safe to run from `pull_request_target`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = '<!-- pr-triage -->';

export const TYPE_LABEL = {
    fix: 'type: fix',
    improvement: 'type: improvement',
    feature: 'type: feature',
    docs: 'type: docs',
};
export const TYPE_NAME = {
    fix: 'Fix',
    improvement: 'Improvement',
    feature: 'New feature',
    docs: 'Documentation',
    release: 'Release (develop to main)',
};
export const OTHER_LABELS = ['needs-type-review', 'touches-base', 'infra', 'needs-maintainer-decision', 'release'];
export const ALL_LABELS = [...Object.values(TYPE_LABEL), ...OTHER_LABELS];

// Files a feature pull request may touch without it being a sign that the base is being edited.
const FEATURE_ALLOWED_OUTSIDE = [
    /^docs\//,
    /^README\.md$/,
    /^\.env\.[^/]*\.example$/,
    /^prisma\//,
    /^package\.json$/,
    /^pnpm-lock\.yaml$/,
];
const DOCS_ONLY = [/^docs\//, /\.md$/];

/** Reads the ticked boxes: `- [x] ... <!-- type:feature -->`. */
export function parseDeclaredTypes(body = '') {
    const found = [];
    for (const match of (body ?? '').matchAll(/^\s*[-*]\s*\[[xX]\][^\n]*?<!--\s*type:(fix|improvement|feature|docs)\s*-->/gm)) {
        found.push(match[1]);
    }
    return [...new Set(found)];
}

/** `gh api --jq '.[] | {filename,status,patch}'` prints one JSON object per line. */
export function parseFilesNdjson(text) {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

const addedLines = (patch = '') => patch.split('\n').filter((line) => line.startsWith('+') && !line.startsWith('+++'));
const removedLines = (patch = '') => patch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));

/** Names of the packages that a package.json patch adds (a version bump is not an addition). */
export function newDependencies(patch = '') {
    const pattern = /^[+-]\s+"([^"]+)":\s*"[\^~]?\d[^"]*"/;
    const names = (lines) => lines.map((line) => line.match(pattern)?.[1]).filter(Boolean);
    const removed = new Set(names(removedLines(patch)));
    return names(addedLines(patch)).filter((name) => !removed.has(name));
}

/** Facts that make a change look like a feature, whatever its author declared. */
export function featureSignals(files) {
    const signals = [];
    const outsideFeatures = files.filter((file) => !file.filename.startsWith('src/features/'));

    if (files.some((f) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(f.filename) && f.status === 'added')) {
        signals.push('adds a database migration');
    }
    if (files.some((f) => f.filename === 'prisma/schema.prisma' && addedLines(f.patch).some((l) => /^\+(model|enum)\s/.test(l)))) {
        signals.push('adds database models');
    }
    if (files.some((f) => f.filename === 'src/config/env.validation.ts' && addedLines(f.patch).some((l) => /^\+\s+[A-Z][A-Z0-9_]*:\s*Joi\./.test(l)))) {
        signals.push('adds environment variables');
    }

    const packageFile = files.find((f) => f.filename === 'package.json');
    const added = packageFile ? newDependencies(packageFile.patch) : [];
    if (added.length > 0) signals.push(`adds dependencies (${added.join(', ')})`);

    if (outsideFeatures.some((f) => f.status === 'added' && /^src\/.*\.module\.ts$/.test(f.filename))) {
        signals.push('adds a Nest module');
    }
    if (outsideFeatures.some((f) => f.status === 'added' && /^src\/.*\.controller\.ts$/.test(f.filename))) {
        signals.push('adds a controller (new routes)');
    }
    return signals;
}

/** Groups the files of `src/features/<name>/` by feature. */
function featureFolders(files) {
    const folders = new Map();
    for (const file of files) {
        const match = file.filename.match(/^src\/features\/([^/]+)\/(.+)$/);
        if (!match) continue;
        if (!folders.has(match[1])) folders.set(match[1], []);
        folders.get(match[1]).push({ ...file, relative: match[2] });
    }
    return folders;
}

/**
 * The branch model: contributors send their pull requests to the INTEGRATION branch (`develop`,
 * the pre-production where everything is tested), and only the maintainers promote `develop` to
 * the RELEASE branch (`main`, production) with a release pull request.
 *
 * A pull request into `main` is accepted only when it comes from `develop` of THIS repository (a
 * release), or from a `hotfix/...` branch of this repository (an urgent fix). Anything else gets an
 * error telling the author to change the base branch.
 *
 * Without `base` (the tests of the rest of this file), no branch rule applies.
 */
export function checkBranches({ base, headRef, headRepo, baseRepo, release = 'main', integration = 'develop' } = {}) {
    if (!base || base !== release) return { release: false, errors: [] };

    const sameRepository = Boolean(headRepo) && headRepo === baseRepo;
    if (sameRepository && headRef === integration) return { release: true, errors: [] };
    if (sameRepository && /^hotfix\//.test(headRef ?? '')) return { release: false, errors: [] };

    return {
        release: false,
        errors: [
            `This pull request targets \`${release}\`, which is production. Pull requests must target \`${integration}\`: ` +
            'click "Edit" next to the title and change the base branch.',
        ],
    };
}

/**
 * @param {{ body: string, files: Array<{filename: string, status: string, patch?: string}>, existingFeatures?: string[], bot?: boolean, branches?: Parameters<typeof checkBranches>[0] }} input
 *   `bot`: the author is an automation (Dependabot...). It has no template to fill in, so its
 *   pull request counts as an improvement.
 */
export function checkPullRequest({ body, files, existingFeatures = [], bot = false, branches }) {
    const branchCheck = checkBranches(branches);

    // A release pull request (develop -> main) gathers many changes that were each checked when
    // they entered develop: there is no single "type" to verify.
    if (branchCheck.release) {
        return { declared: [], kind: 'release', newFeatures: [], errors: [], warnings: [], labels: ['release'] };
    }

    const errors = [...branchCheck.errors];
    const warnings = [];
    const labels = new Set();
    let declared = parseDeclaredTypes(body);
    if (bot && declared.length === 0) declared = ['improvement'];

    if (declared.length === 0) {
        errors.push('Tick the type of your change in the pull request description (Fix, Improvement, New feature or Documentation).');
    } else if (declared.length > 1) {
        errors.push(`Tick only one type of change (you ticked ${declared.map((t) => TYPE_NAME[t]).join(' and ')}). If it is both, split it in two pull requests.`);
    }
    const kind = declared.length === 1 ? declared[0] : null;
    if (kind) labels.add(TYPE_LABEL[kind]);

    const folders = featureFolders(files);
    const existing = new Set(existingFeatures);
    const newFeatures = [...folders.keys()].filter((name) => !existing.has(name));

    // ---- Problems that concern the features themselves --------------------------------------
    for (const name of newFeatures) {
        const inFolder = folders.get(name);
        const manifest = inFolder.find((f) => f.relative === 'feature.ts');

        if (!manifest) {
            errors.push(`src/features/${name}/ has no feature.ts: every feature needs its manifest (run "pnpm feature:new ${name}" for a skeleton).`);
        } else if (addedLines(manifest.patch).some((l) => /^\+\s*defaultEnabled:\s*true/.test(l))) {
            errors.push(`src/features/${name}/feature.ts sets defaultEnabled: true. A new feature must be off by default; only a maintainer can change that later.`);
        }
        if (!inFolder.some((f) => /\.spec\.ts$/.test(f.relative) && f.status !== 'removed')) {
            errors.push(`src/features/${name}/ has no test (*.spec.ts). A feature must be tested switched on and switched off.`);
        }
    }

    for (const [name, inFolder] of folders) {
        if (!existing.has(name)) continue;
        const manifest = inFolder.find((f) => f.relative === 'feature.ts');
        if (manifest && addedLines(manifest.patch).some((l) => /^\+\s*defaultEnabled:\s*true/.test(l))) {
            warnings.push(`src/features/${name}/feature.ts now enables the feature by default: only a maintainer decides when a feature joins the base.`);
            labels.add('needs-maintainer-decision');
        }
    }

    // ---- Does the declared type match the content? ------------------------------------------
    const signals = featureSignals(files);

    if (kind === 'feature') {
        if (newFeatures.length === 0) {
            errors.push('You ticked "New feature" but this pull request adds no new src/features/<name>/ folder. If you improve a feature that already exists, tick "Improvement".');
        }
        const base = files.filter(
            (f) => !f.filename.startsWith('src/features/') || /^src\/features\/[^/]+$/.test(f.filename),
        ).filter((f) => !FEATURE_ALLOWED_OUTSIDE.some((pattern) => pattern.test(f.filename)));
        const baseSource = base.filter((f) => !/^(\.github\/|scripts\/)/.test(f.filename));

        if (baseSource.length > 0) {
            warnings.push(
                'A feature should not edit the base. These files are outside src/features/<name>/: ' +
                baseSource.map((f) => `\`${f.filename}\``).join(', ') +
                '. If the base needs a hook, send it first as a separate "Improvement" pull request.',
            );
            labels.add('touches-base');
        }
    } else if (kind === 'improvement' || kind === 'fix') {
        if (newFeatures.length > 0) {
            errors.push(`This pull request adds src/features/${newFeatures[0]}/, which is a new feature. Tick "New feature" instead.`);
        } else if (signals.length > 0) {
            warnings.push(
                `You declared an ${kind === 'fix' ? 'fix' : 'improvement'}, but the change ${signals.join(', ')}. ` +
                'If this is something a person could want to switch off, it is a feature: a maintainer will confirm.',
            );
            labels.add('needs-type-review');
        }
    } else if (kind === 'docs') {
        const other = files.filter((f) => !DOCS_ONLY.some((pattern) => pattern.test(f.filename)));
        if (other.length > 0) {
            warnings.push(`You declared documentation, but these files are not documentation: ${other.slice(0, 5).map((f) => `\`${f.filename}\``).join(', ')}${other.length > 5 ? ', ...' : ''}.`);
            labels.add('needs-type-review');
        }
    }

    if (files.some((f) => /^(\.github\/|scripts\/)/.test(f.filename))) {
        labels.add('infra');
        warnings.push('This pull request changes the workflows or the scripts: it needs a review from an owner.');
    }

    return { declared, kind, newFeatures, errors, warnings, labels: [...labels] };
}

/** The sticky comment posted on the pull request. */
export function renderComment(result) {
    const lines = [MARKER, '### Pull request check', ''];
    lines.push(`**Declared type:** ${result.kind ? TYPE_NAME[result.kind] : 'none'}`);
    if (result.newFeatures.length > 0) lines.push(`**New feature(s):** ${result.newFeatures.map((n) => `\`${n}\``).join(', ')}`);
    lines.push('');

    if (result.errors.length === 0 && result.warnings.length === 0) {
        lines.push('✅ Everything is consistent.');
    }
    if (result.errors.length > 0) {
        lines.push('❌ **To fix before this pull request can be merged:**', '');
        for (const error of result.errors) lines.push(`- ${error}`);
        lines.push('');
    }
    if (result.warnings.length > 0) {
        lines.push('⚠️ **A maintainer will look at:**', '');
        for (const warning of result.warnings) lines.push(`- ${warning}`);
        lines.push('');
    }
    lines.push(
        '<sub>Not sure whether your change is a feature or an improvement? ' +
        'See [`src/features/README.md`](../blob/main/src/features/README.md) and [`CONTRIBUTING.md`](../blob/main/CONTRIBUTING.md).</sub>',
    );
    return lines.join('\n') + '\n';
}

function readFlag(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}

function main() {
    const args = process.argv.slice(2);
    const filesPath = readFlag(args, '--files');
    const outPath = readFlag(args, '--out') ?? 'pr-result.json';
    const commentPath = readFlag(args, '--comment') ?? 'pr-comment.md';
    const featuresDir = readFlag(args, '--features-dir') ?? 'src/features';

    if (!filesPath) {
        console.error('Usage: node scripts/pr-check.mjs --files <files.ndjson> [--out result.json] [--comment comment.md]');
        process.exit(2);
    }

    const existingFeatures = fs.existsSync(featuresDir)
        ? fs.readdirSync(featuresDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        : [];

    const result = checkPullRequest({
        body: process.env.PR_BODY ?? '',
        files: parseFilesNdjson(fs.readFileSync(filesPath, 'utf8')),
        existingFeatures,
        bot: (process.env.PR_AUTHOR ?? '').endsWith('[bot]'),
        branches: {
            base: process.env.PR_BASE,
            headRef: process.env.PR_HEAD_REF,
            headRepo: process.env.PR_HEAD_REPO,
            baseRepo: process.env.PR_BASE_REPO,
            release: process.env.RELEASE_BRANCH || 'main',
            integration: process.env.INTEGRATION_BRANCH || 'develop',
        },
    });

    // The labels this tool manages and that no longer apply, so that the workflow removes them.
    result.remove = ALL_LABELS.filter((label) => !result.labels.includes(label));

    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    fs.writeFileSync(commentPath, renderComment(result));

    for (const error of result.errors) console.log(`::error::${error}`);
    for (const warning of result.warnings) console.log(`::warning::${warning}`);
    console.log(`kind=${result.kind ?? 'none'} errors=${result.errors.length} warnings=${result.warnings.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
