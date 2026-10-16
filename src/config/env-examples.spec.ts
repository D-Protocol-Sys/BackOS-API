import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'dotenv';
import { validationSchema } from './env.validation';

/**
 * The settings examples that are meant to work AS THEY ARE (without filling in any placeholder)
 * must pass the application's own validation. The end-to-end tests start from .env.test.example,
 * and a developer starts from .env.development.example: if one of them is rejected by the
 * validation, nobody can start the application from it.
 *
 * A past mistake this guards against: the test example used e-mail addresses ending in ".test",
 * which the validation (rightly) rejects because ".test" is not a real top-level domain.
 */
describe('settings examples that must work as they are', () => {
    const root = path.resolve(__dirname, '../..');

    it.each(['.env.development.example', '.env.test.example'])('%s passes the real validation', (file) => {
        const values = parse(fs.readFileSync(path.join(root, file)));

        const { error } = validationSchema.validate(values, { abortEarly: false, allowUnknown: true });

        expect(error?.message).toBeUndefined();
    });

    it('the CI builds .env.test from the example, and an undefined secret does not blank the values out', () => {
        // Same logic as the "Populate test environment configuration" step of the CI workflow.
        const example = fs.readFileSync(path.join(root, '.env.test.example'), 'utf8');
        const secrets = { CI_ENCRYPTION_KEY: '', CI_JWT_SECRET: '' };
        let built = example;
        if (secrets.CI_ENCRYPTION_KEY) built += `\nENCRYPTION_KEY=${secrets.CI_ENCRYPTION_KEY}`;
        if (secrets.CI_JWT_SECRET) built += `\nJWT_SECRET=${secrets.CI_JWT_SECRET}`;

        const values = parse(built);

        expect(values.ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/i);
        expect(String(values.JWT_SECRET).length).toBeGreaterThanOrEqual(32);
        expect(validationSchema.validate(values, { abortEarly: false, allowUnknown: true }).error).toBeUndefined();
    });
});
