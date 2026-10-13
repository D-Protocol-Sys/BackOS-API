#!/usr/bin/env node
/**
 * `pnpm feature:new <name>` - creates the skeleton of an optional feature in
 * src/features/<name>/ (manifest, module, controller, service and their tests).
 *
 * The skeleton is deliberately "red until you finish it": its test fails while the manifest still
 * contains a TODO, so that a feature is never shipped with placeholder descriptions.
 *
 * See src/features/README.md for the conventions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const toPascalCase = (name) =>
    name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');

export const toEnvPrefix = (name) => `${name.toUpperCase().replace(/-/g, '_')}_`;

/** Returns an error message, or null when the name can be used. */
export function validateName(name, root = REPO_ROOT) {
    if (!name) return 'Missing name. Usage: pnpm feature:new <name>   (for example: pnpm feature:new my-feature)';
    if (!NAME_PATTERN.test(name)) {
        return `"${name}" is not a valid name: use kebab-case (lowercase letters, digits and single dashes, starting with a letter).`;
    }
    if (name === 'all') return '"all" is reserved: it enables every feature in ENABLED_FEATURES.';
    if (fs.existsSync(path.join(root, 'src', 'features', name))) return `src/features/${name}/ already exists.`;
    if (fs.existsSync(path.join(root, 'src', name))) {
        return `src/${name}/ is part of the base BackOS. Pick a name that does not clash with it.`;
    }

    const permissionsFile = path.join(root, 'src', 'common', 'constants', 'permissions.constant.ts');
    if (fs.existsSync(permissionsFile) && fs.readFileSync(permissionsFile, 'utf8').includes(`'${name}.`)) {
        return `The permission namespace "${name}." is already used by the base BackOS. Pick another name.`;
    }
    return null;
}

/** The files of the skeleton, as { fileName: content }. */
export function render(name) {
    const Pascal = toPascalCase(name);
    const PREFIX = toEnvPrefix(name);

    return {
        'feature.ts': `import * as Joi from 'joi';
import { defineFeature } from '../feature.types';
import { ${Pascal}Module } from './${name}.module';

export default defineFeature({
    name: '${name}',
    description: 'TODO: say in one sentence what ${name} adds.',
    defaultEnabled: false, // always false for a new feature
    module: ${Pascal}Module,
    permissions: {
        '${name}.read': 'TODO: View ...',
        '${name}.manage': 'TODO: Create, edit and delete ...',
    },
    env: {
        // Every variable must start with ${PREFIX} and be optional or have a default.
        ${PREFIX}EXAMPLE_LIMIT: Joi.number().integer().min(1).default(10),
    },
    // Variables that must be set only when the feature is switched on:
    requiredEnv: [],
});
`,

        [`${name}.module.ts`]: `import { Module } from '@nestjs/common';
import { ${Pascal}Controller } from './${name}.controller';
import { ${Pascal}Service } from './${name}.service';

@Module({
    controllers: [${Pascal}Controller],
    providers: [${Pascal}Service],
})
export class ${Pascal}Module {}
`,

        [`${name}.controller.ts`]: `import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { featurePermission } from '../feature.types';
import { ${Pascal}Service } from './${name}.service';

@ApiTags('${Pascal}')
@ApiBearerAuth('access-token')
@Controller('${name}')
export class ${Pascal}Controller {

    constructor(private readonly service: ${Pascal}Service) {}

    // Every route must have @RequirePermissions(...), @Public(), or a documented manual check
    // (see src/common/route-permission-audit.spec.ts): a test enforces it.
    @RequirePermissions(featurePermission('${name}.read'))
    @Get()
    status() {
        return this.service.status();
    }
}
`,

        [`${name}.service.ts`]: `import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ${Pascal}Service {

    constructor(private readonly config: ConfigService) {}

    status() {
        return {
            feature: '${name}',
            limit: this.config.get<number>('${PREFIX}EXAMPLE_LIMIT'),
        };
    }
}
`,

        [`${name}.service.spec.ts`]: `import { ConfigService } from '@nestjs/config';
import { ${Pascal}Service } from './${name}.service';

describe('${Pascal}Service', () => {

    it('reports its status', () => {
        const config = { get: jest.fn().mockReturnValue(10) } as unknown as ConfigService;

        expect(new ${Pascal}Service(config).status()).toEqual({ feature: '${name}', limit: 10 });
    });
});
`,

        'feature.spec.ts': `import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { FeaturesModule } from '../features.module';
import manifest from './feature';
import { ${Pascal}Service } from './${name}.service';

describe('feature "${name}"', () => {

    it('has a complete manifest and is off by default', () => {
        expect(manifest.defaultEnabled).toBe(false);

        // Red until you have replaced every TODO of feature.ts.
        expect(manifest.description).not.toMatch(/TODO/);
        for (const description of Object.values(manifest.permissions ?? {})) {
            expect(description).not.toMatch(/TODO/);
        }
    });

    describe('loading', () => {

        const original = process.env.ENABLED_FEATURES;
        let app: TestingModule | undefined;

        async function boot(enabled: string): Promise<TestingModule> {
            process.env.ENABLED_FEATURES = enabled;

            app = await Test.createTestingModule({
                imports: [
                    ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
                    FeaturesModule.register({ manifests: [manifest] }),
                ],
            }).compile();

            return app;
        }

        const isLoaded = (moduleRef: TestingModule) => {
            try {
                moduleRef.get(${Pascal}Service, { strict: false });
                return true;
            } catch {
                return false;
            }
        };

        afterEach(async () => {
            await app?.close();
            app = undefined;
            if (original === undefined) delete process.env.ENABLED_FEATURES;
            else process.env.ENABLED_FEATURES = original;
        });

        it('is not loaded when it is switched off', async () => {
            expect(isLoaded(await boot(''))).toBe(false);
        });

        it('is loaded when it is switched on', async () => {
            expect(isLoaded(await boot('${name}'))).toBe(true);
        });
    });
});
`,

        'README.md': `# ${name}

TODO: what this feature does, in a few sentences, and who it is for.

## Switch it on

\`\`\`ini
ENABLED_FEATURES=${name}
\`\`\`

## Settings

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| \`${PREFIX}EXAMPLE_LIMIT\` | \`10\` | TODO |

## Permissions

| Permission | Allows |
| ---------- | ------ |
| \`${name}.read\` | TODO |
| \`${name}.manage\` | TODO |

## Routes

| Route | Permission | Purpose |
| ----- | ---------- | ------- |
| \`GET /api/${name}\` | \`${name}.read\` | TODO |

## Database

TODO: the tables this feature adds (they exist, empty, even when it is switched off), or "none".
`,
    };
}

/** Writes the skeleton and returns the list of the files created. */
export function scaffold(name, root = REPO_ROOT) {
    const error = validateName(name, root);
    if (error) throw new Error(error);

    const dir = path.join(root, 'src', 'features', name);
    fs.mkdirSync(dir, { recursive: true });

    const created = [];
    for (const [file, content] of Object.entries(render(name))) {
        fs.writeFileSync(path.join(dir, file), content);
        created.push(path.join('src', 'features', name, file).replace(/\\/g, '/'));
    }
    return created;
}

function main() {
    const name = process.argv[2];
    try {
        const created = scaffold(name);
        console.log(`\nFeature "${name}" created:\n${created.map((file) => `  ${file}`).join('\n')}\n`);
        console.log('Next steps:');
        console.log('  1. Open src/features/' + name + '/feature.ts and replace every TODO (description, permissions).');
        console.log('  2. Write your code, and its tests. `pnpm test` stays red until the TODOs are gone.');
        console.log('  3. Switch it on to try it:  ENABLED_FEATURES=' + name + '  in your .env and .env.development');
        console.log('  4. If it needs database tables, add them with their migration (see src/features/README.md).');
        console.log('  5. Open your pull request and choose "New feature".\n');
    } catch (error) {
        console.error(`\n${error.message}\n`);
        process.exit(1);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
