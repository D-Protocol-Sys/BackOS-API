import type { Type } from '@nestjs/common';
import type { PartialSchemaMap } from 'joi';

/**
 * An optional feature: a self-contained piece of BackOS that people can switch on or off with
 * the `ENABLED_FEATURES` setting. See `src/features/README.md` for the convention and
 * `docs/FEATURES.md` for the user-facing documentation.
 *
 * Every feature lives in `src/features/<name>/` and exposes its manifest as the default export
 * of `src/features/<name>/feature.ts`:
 *
 * ```ts
 * // `my-feature` is a placeholder: use the name of your own feature.
 * export default defineFeature({
 *     name: 'my-feature',
 *     description: 'What my-feature adds, in one sentence',
 *     defaultEnabled: false,
 *     module: MyFeatureModule,
 *     permissions: { 'my-feature.read': 'View my-feature data', 'my-feature.write': 'Edit my-feature data' },
 * });
 * ```
 */
export interface FeatureManifest {
    /** Kebab-case identifier. Must be identical to the folder name. Used in `ENABLED_FEATURES`. */
    name: string;

    /** One sentence, in English, shown by `GET /api/features` and in the documentation. */
    description: string;

    /**
     * Whether the feature is on when `ENABLED_FEATURES` does not mention it.
     * New features MUST be `false`: the base BackOS must behave exactly as before for anyone who
     * does not ask for them. Only a maintainer flips this, when a feature "graduates" to the base.
     */
    defaultEnabled: boolean;

    /** The Nest module that provides the feature's controllers and services. */
    module: Type<unknown>;

    /**
     * The permissions the feature adds to the global catalog, as `{ key: description }`.
     * Every key must be namespaced with the feature name (`<name>.<action>`).
     *
     * They are synchronized into the database EVEN WHEN THE FEATURE IS DISABLED: the permission
     * catalog sync deletes any permission it does not know about (and revokes it from every
     * role), so leaving them out while the feature is off would silently wipe the roles'
     * assignments, and switching the feature back on would not restore them.
     */
    permissions?: Record<string, string>;

    /**
     * Environment variables of the feature, as Joi rules. Every name must start with the
     * feature's prefix (`MY_FEATURE_...` for `my-feature`). They are validated at boot like the
     * core ones, so each one MUST be optional or carry a `.default()`: a disabled feature must
     * never prevent BackOS from starting. Use `requiredEnv` for the ones that are mandatory
     * only when the feature is on.
     */
    env?: PartialSchemaMap;

    /** Variables that must be set (non-empty) only when the feature is enabled. */
    requiredEnv?: string[];
}

/** What `GET /api/features` returns for each discovered feature. */
export interface FeatureInfo {
    name: string;
    description: string;
    enabled: boolean;
}

declare const featurePermissionBrand: unique symbol;
declare const featureAuditActionBrand: unique symbol;
declare const featureAuditTargetBrand: unique symbol;

/**
 * A permission key declared by a feature. Branded so that a mistyped CORE permission string
 * still fails to compile, while a feature can use its own keys in `@RequirePermissions(...)`.
 */
export type FeaturePermissionKey = string & { readonly [featurePermissionBrand]: true };

/** An audit action name owned by a feature (for example `my-feature.item.created`). */
export type FeatureAuditAction = string & { readonly [featureAuditActionBrand]: true };

/** An audit target type owned by a feature (for example `MyFeatureItem`). */
export type FeatureAuditTarget = string & { readonly [featureAuditTargetBrand]: true };

/** Marks a string as a permission key declared in a feature manifest. */
export const featurePermission = (key: string): FeaturePermissionKey => key as FeaturePermissionKey;

/** Marks a string as an audit action owned by a feature. */
export const featureAuditAction = (action: string): FeatureAuditAction => action as FeatureAuditAction;

/** Marks a string as an audit target type owned by a feature. */
export const featureAuditTarget = (target: string): FeatureAuditTarget => target as FeatureAuditTarget;

export const FEATURE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** `my-feature` -> `MY_FEATURE_` */
export function featureEnvPrefix(name: string): string {
    return `${name.toUpperCase().replace(/-/g, '_')}_`;
}

/**
 * Checks a manifest and returns it unchanged. Throws an explicit error on the first rule broken,
 * so that a contributor finds out at boot (and in the tests) rather than in production.
 */
export function assertValidManifest(manifest: FeatureManifest, source = 'feature manifest'): FeatureManifest {
    const fail = (message: string): never => {
        throw new Error(`Invalid ${source}${manifest?.name ? ` "${manifest.name}"` : ''}: ${message}`);
    };

    if (!manifest || typeof manifest !== 'object') return fail('the manifest must be an object.');

    if (typeof manifest.name !== 'string' || !FEATURE_NAME_PATTERN.test(manifest.name)) {
        return fail('`name` must be kebab-case (lowercase letters, digits and single dashes, starting with a letter).');
    }
    if (manifest.name === 'all') return fail('`all` is reserved: it enables every feature in `ENABLED_FEATURES`.');
    if (typeof manifest.description !== 'string' || manifest.description.trim() === '') {
        return fail('`description` is required.');
    }
    if (typeof manifest.defaultEnabled !== 'boolean') return fail('`defaultEnabled` must be true or false.');
    if (typeof manifest.module !== 'function') return fail('`module` must be a Nest module class.');

    for (const [key, description] of Object.entries(manifest.permissions ?? {})) {
        if (!key.startsWith(`${manifest.name}.`)) {
            return fail(`permission "${key}" must start with "${manifest.name}.".`);
        }
        if (typeof description !== 'string' || description.trim() === '') {
            return fail(`permission "${key}" needs a description.`);
        }
    }

    const prefix = featureEnvPrefix(manifest.name);
    for (const key of Object.keys(manifest.env ?? {})) {
        if (!key.startsWith(prefix)) return fail(`environment variable "${key}" must start with "${prefix}".`);
    }
    for (const key of manifest.requiredEnv ?? []) {
        if (!key.startsWith(prefix)) return fail(`required variable "${key}" must start with "${prefix}".`);
    }

    return manifest;
}

/**
 * Declares a feature. Use it as the default export of `src/features/<name>/feature.ts`.
 */
export function defineFeature(manifest: FeatureManifest): FeatureManifest {
    return Object.freeze(assertValidManifest(manifest));
}
