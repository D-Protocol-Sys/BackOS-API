import { Module } from '@nestjs/common';
import { FeatureManifest } from './feature.types';
import { isFeatureEnabled, parseFeatureList, resolveEnabledFeatures, UnknownFeatureError } from './feature-selection';

@Module({})
class AnyModule {}

const manifest = (name: string, defaultEnabled = false): FeatureManifest => ({
    name,
    description: name,
    defaultEnabled,
    module: AnyModule,
});

const manifests = [manifest('alpha'), manifest('beta'), manifest('gamma', true)];

const enabled = (raw: string | undefined) => [...resolveEnabledFeatures(manifests, raw)].sort();

describe('parseFeatureList', () => {
    it('splits on commas and spaces, trims and lower-cases', () => {
        expect(parseFeatureList(' Alpha, beta  GAMMA ,, ')).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('returns an empty list for nothing', () => {
        expect(parseFeatureList(undefined)).toEqual([]);
        expect(parseFeatureList('')).toEqual([]);
    });
});

describe('resolveEnabledFeatures', () => {

    it('keeps only the features enabled by default when nothing is set', () => {
        expect(enabled(undefined)).toEqual(['gamma']);
        expect(enabled('')).toEqual(['gamma']);
    });

    it('adds the features that are named (additive)', () => {
        expect(enabled('alpha')).toEqual(['alpha', 'gamma']);
        expect(enabled('alpha,beta')).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('turns on everything with "all"', () => {
        expect(enabled('all')).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('turns a feature off with a leading dash', () => {
        expect(enabled('-gamma')).toEqual([]);
        expect(enabled('all,-beta')).toEqual(['alpha', 'gamma']);
    });

    it('applies the tokens from left to right', () => {
        expect(enabled('-gamma,gamma')).toEqual(['gamma']);
        expect(enabled('gamma,-gamma')).toEqual([]);
    });

    it('rejects an unknown name and lists the installed features', () => {
        expect(() => resolveEnabledFeatures(manifests, 'alpha,alpah')).toThrow(UnknownFeatureError);
        expect(() => resolveEnabledFeatures(manifests, 'alpah')).toThrow(/"alpah".*Installed features: alpha, beta, gamma/);
    });

    it('rejects an unknown name even with a dash', () => {
        expect(() => resolveEnabledFeatures(manifests, '-nope')).toThrow(/"-nope"/);
    });

    it('explains that nothing is installed when there is no feature at all', () => {
        expect(() => resolveEnabledFeatures([], 'alpha')).toThrow(/No optional feature is installed/);
    });

    it('accepts an empty installation with no setting', () => {
        expect(resolveEnabledFeatures([], undefined).size).toBe(0);
    });
});

describe('isFeatureEnabled', () => {
    it('answers for one feature', () => {
        expect(isFeatureEnabled(manifests, 'alpha', 'alpha')).toBe(true);
        expect(isFeatureEnabled(manifests, 'beta', 'alpha')).toBe(false);
    });
});
