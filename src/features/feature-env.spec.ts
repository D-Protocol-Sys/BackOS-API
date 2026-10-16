import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'dotenv';
import * as Joi from 'joi';
import { Module } from '@nestjs/common';
import { validationSchema } from '../config/env.validation';
import { validateFeatureEnv } from './feature-env';
import { FeatureManifest } from './feature.types';

@Module({})
class AlphaModule {}

const alpha: FeatureManifest = {
    name: 'alpha',
    description: 'Alpha',
    defaultEnabled: false,
    module: AlphaModule,
    env: {
        ALPHA_LIMIT: Joi.number().integer().min(1).default(5),
        ALPHA_TOKEN: Joi.string().optional(),
    },
    requiredEnv: ['ALPHA_TOKEN'],
};

describe('validateFeatureEnv', () => {
    it('applies the defaults of the features own variables', () => {
        const { value, errors } = validateFeatureEnv({}, [alpha]);

        expect(errors).toEqual([]);
        expect(value).toEqual({ ALPHA_LIMIT: 5 });
    });

    it('does not require anything from a feature that is switched off', () => {
        expect(validateFeatureEnv({ ENABLED_FEATURES: '' }, [alpha]).errors).toEqual([]);
    });

    it('requires the mandatory variables of a feature that is switched on', () => {
        const { errors } = validateFeatureEnv({ ENABLED_FEATURES: 'alpha' }, [alpha]);

        expect(errors).toEqual(['Feature "alpha" is enabled but ALPHA_TOKEN is not set.']);
    });

    it('accepts an enabled feature once its mandatory variables are set', () => {
        const { errors } = validateFeatureEnv({ ENABLED_FEATURES: 'alpha', ALPHA_TOKEN: 'abc' }, [alpha]);

        expect(errors).toEqual([]);
    });

    it('treats a blank mandatory variable as missing', () => {
        const { errors } = validateFeatureEnv({ ENABLED_FEATURES: 'alpha', ALPHA_TOKEN: '   ' }, [alpha]);

        expect(errors).toHaveLength(1);
    });

    it('reports an invalid value of a features own variable', () => {
        const { errors } = validateFeatureEnv({ ALPHA_LIMIT: 'many' }, [alpha]);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatch(/ALPHA_LIMIT/);
    });

    it('reports an unknown feature name', () => {
        const { errors } = validateFeatureEnv({ ENABLED_FEATURES: 'alpah' }, [alpha]);

        expect(errors[0]).toMatch(/Unknown feature\(s\).*"alpah".*Installed features: alpha/);
    });
});

describe('validationSchema (real environment validation)', () => {
    // The development example file is meant to work as it is, so it doubles as a valid base.
    const base = parse(fs.readFileSync(path.resolve(__dirname, '../../.env.development.example')));

    const validate = (extra: Record<string, string> = {}) =>
        validationSchema.validate({ ...base, ...extra }, { abortEarly: false, allowUnknown: true });

    it('accepts the development example file with no ENABLED_FEATURES', () => {
        expect(validate().error).toBeUndefined();
    });

    it('accepts an empty ENABLED_FEATURES', () => {
        expect(validate({ ENABLED_FEATURES: '' }).error).toBeUndefined();
    });

    it('stops the boot on an unknown feature, with a clear message', () => {
        const { error } = validate({ ENABLED_FEATURES: 'does-not-exist' });

        expect(error).toBeDefined();
        expect(error?.message).toMatch(/Unknown feature\(s\) in ENABLED_FEATURES: "does-not-exist"/);
    });
});
