import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceBlueprint } from './service-blueprint.types';
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
     * Returns the full array of available service blueprints in the system.
     * @returns List of all `ServiceBlueprint` definitions.
     */
    list(): ServiceBlueprint[] {
        return ALL_BLUEPRINTS;
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
     * Validates an incoming configuration object against the rules defined in the blueprint.
     * Checks for unexpected/unknown properties and ensures all required fields are supplied.
     * * @param key - The service key identifying the blueprint.
     * @param providedConfig - The raw key-value configuration payload to validate.
     * @throws `BadRequestException` if unknown keys are passed or mandatory fields are missing/empty.
     */
    validateConfig(key: string, providedConfig: Record<string, unknown>): void {
        const blueprint = this.getByKey(key);
        const allowedKeys = new Set(blueprint.configFields.map((f) => f.key));

        // 1. Reject extraneous keys that are not defined in the blueprint's configuration schema
        for (const providedKey of Object.keys(providedConfig)) {
            if (!allowedKeys.has(providedKey)) {
                throw new BadRequestException(`Unknown configuration field for "${key}": "${providedKey}"`);
            }
        }

        // 2. Ensure all mandatory fields defined as required in the blueprint are present and non-empty
        for (const field of blueprint.configFields) {
            if (field.required && (providedConfig[field.key] === undefined || providedConfig[field.key] === '')) {
                throw new BadRequestException(`The field "${field.label}" is required for service "${blueprint.name}".`);
            }
        }
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
}