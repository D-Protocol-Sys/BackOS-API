import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceBlueprint, ServiceConfigField } from './service-blueprint.types';
import { AUTH_USER_BLUEPRINT } from './blueprints/auth-user.blueprint';
import { MAILING_BLUEPRINT } from './blueprints/mailing.blueprint';
import { SCHEDULER_BLUEPRINT } from './blueprints/scheduler.blueprint';

/**
 * Registry array holding all registered service blueprints available in the platform catalog.
 */
const ALL_BLUEPRINTS: ServiceBlueprint[] = [
    AUTH_USER_BLUEPRINT,
    MAILING_BLUEPRINT,
    SCHEDULER_BLUEPRINT,
];

/**
 * Service acting as a centralized registry/catalog for service blueprints.
 * Responsible for blueprint discovery, strict input configuration validation, 
 * and segregating sensitive settings from standard plain configuration properties.
 */
@Injectable()
export class ServiceCatalog {

    /**
     * Returns the catalog as exposed to the front-end (`GET /service-catalog`): every blueprint,
     * WITHOUT its internal (`system`) config fields, and with its `dependsOn` prerequisites so a
     * form can show "requires Mailing" and disable the toggle until that service is on.
     * @returns List of public `ServiceBlueprint` definitions.
     */
    list(): ServiceBlueprint[] {
        return ALL_BLUEPRINTS.map((blueprint) => ({
            ...blueprint,
            dependsOn: blueprint.dependsOn ?? [],
            // A config-driven Prisma generator is a function - not serialisable, and not something
            // a client needs to see.
            prismaModels: typeof blueprint.prismaModels === 'string' ? blueprint.prismaModels : undefined,
            configFields: blueprint.configFields.filter((field) => !field.system),
        }));
    }

    /**
     * Finds a specific blueprint by its unique key.
     * * @param key - The unique identifier of the service (e.g., "auth-user", "mailing").
     * @returns The matching `ServiceBlueprint`.
     * @throws `NotFoundException` if no blueprint matches the provided key.
     */
    getByKey(key: string): ServiceBlueprint {
        const blueprint = ALL_BLUEPRINTS.find((b) => b.key === key);
        if (!blueprint) throw new NotFoundException(`Unknown service: "${key}"`);
        return blueprint;
    }

    /**
     * Blueprints of the services that must be active BEFORE `key` can be (its prerequisites).
     */
    getDependencies(key: string): ServiceBlueprint[] {
        return (this.getByKey(key).dependsOn ?? []).map((dependencyKey) => this.getByKey(dependencyKey));
    }

    /**
     * Blueprints of the services that REQUIRE `key` to be active (the reverse of `getDependencies`).
     */
    getDependents(key: string): ServiceBlueprint[] {
        return ALL_BLUEPRINTS.filter((blueprint) => blueprint.dependsOn?.includes(key));
    }

    /**
     * Resolves the Prisma models a service contributes, whether declared as a fixed snippet or as
     * a function of the service's full configuration.
     */
    resolvePrismaModels(key: string, fullConfig: Record<string, unknown>): string | undefined {
        const { prismaModels } = this.getByKey(key);
        if (!prismaModels) return undefined;
        return typeof prismaModels === 'function' ? prismaModels(fullConfig) : prismaModels;
    }

    /**
     * Validates an incoming configuration object against the rules defined in the blueprint.
     * Checks for unexpected/unknown properties, ensures all required fields are supplied, and that
     * typed fields (`boolean` / `number`) hold a value of the right kind.
     * * @param key - The service key identifying the blueprint.
     * @param providedConfig - The raw key-value configuration payload to validate.
     * @throws `BadRequestException` if unknown keys are passed or mandatory fields are missing/empty.
     */
    validateConfig(key: string, providedConfig: Record<string, unknown>): void {
        const blueprint = this.getByKey(key);
        // Internal (`system`) fields are managed by the platform itself, so they are NOT accepted from the caller.
        const allowedKeys = new Set(blueprint.configFields.filter((f) => !f.system).map((f) => f.key));

        // 1. Reject extraneous keys that are not defined in the blueprint's configuration schema
        for (const providedKey of Object.keys(providedConfig)) {
            if (!allowedKeys.has(providedKey)) {
                throw new BadRequestException(`Unknown configuration field for "${key}": "${providedKey}"`);
            }
        }

        // 2. Ensure all mandatory fields defined as required in the blueprint are present and non-empty
        for (const field of blueprint.configFields) {
            if (field.system) continue;
            if (field.required && (providedConfig[field.key] === undefined || providedConfig[field.key] === '')) {
                throw new BadRequestException(`The field "${field.label}" is required for service "${blueprint.name}".`);
            }
        }

        // 3. Ensure typed fields actually hold a value of that type
        for (const field of blueprint.configFields) {
            if (field.system) continue;
            const value = providedConfig[field.key];
            if (value === undefined || value === '') continue;
            if (!this.isValidForType(field, value)) {
                throw new BadRequestException(`The field "${field.label}" must be a ${field.type}.`);
            }
        }
    }

    /**
     * Coerces typed values to their real type (`"true"` -> `true`, `"587"` -> `587`) so that what is
     * stored and later read back by the generators is always a proper boolean / number, whatever
     * the client sent. Must be called AFTER `validateConfig()`.
     */
    normalizeConfig(key: string, providedConfig: Record<string, unknown>): Record<string, unknown> {
        const blueprint = this.getByKey(key);
        const normalized: Record<string, unknown> = { ...providedConfig };

        for (const field of blueprint.configFields) {
            const value = normalized[field.key];
            if (value === undefined || value === '') {
                delete normalized[field.key];
                continue;
            }
            if (field.type === 'boolean') normalized[field.key] = value === true || value === 'true';
            if (field.type === 'number') normalized[field.key] = Number(value);
        }

        return normalized;
    }

    /**
     * Splits a validated configuration object into two distinct dictionaries:
     * one for plain/public configurations and another for sensitive/secret values 
     * (e.g., API secrets, passwords) to enable secure storage/handling.
     * * @param key - The target service key.
     * @param fullConfig - Complete configuration object to split.
     * @returns An object containing separated `plain` and `secret` dictionaries.
     */
    splitConfig(
        key: string,
        fullConfig: Record<string, unknown>,
    ): { plain: Record<string, unknown>; secret: Record<string, unknown> } {
        const blueprint = this.getByKey(key);
        const plain: Record<string, unknown> = {};
        const secret: Record<string, unknown> = {};

        for (const field of blueprint.configFields) {
            const value = fullConfig[field.key];
            if (value === undefined) continue;
            
            // Route values into separate stores based on the blueprint's secret flag
            if (field.secret) secret[field.key] = value;
            else plain[field.key] = value;
        }

        return { plain, secret };
    }

    private isValidForType(field: ServiceConfigField, value: unknown): boolean {
        switch (field.type) {
            case 'boolean':
                return typeof value === 'boolean' || value === 'true' || value === 'false';
            case 'number':
                return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value));
            default:
                return true;
        }
    }
}
