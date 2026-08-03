import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ServiceBlueprint } from './service-blueprint.types';
import { AUTH_USER_BLUEPRINT } from './blueprints/auth-user.blueprint';
import { MAILING_BLUEPRINT } from './blueprints/mailing.blueprint';
import { SCHEDULER_BLUEPRINT } from './blueprints/scheduler.blueprint';

const ALL_BLUEPRINTS: ServiceBlueprint[] = [
    AUTH_USER_BLUEPRINT,
    MAILING_BLUEPRINT,
    SCHEDULER_BLUEPRINT,
];

@Injectable()
export class ServiceCatalog {

    list(): ServiceBlueprint[] {
        return ALL_BLUEPRINTS;
    }

    getByKey(key: string): ServiceBlueprint {
        const blueprint = ALL_BLUEPRINTS.find((b) => b.key === key);
        if (!blueprint) throw new NotFoundException(`Service inconnu : "${key}"`);
        return blueprint;
    }

    validateConfig(key: string, providedConfig: Record<string, unknown>): void {
        const blueprint = this.getByKey(key);
        const allowedKeys = new Set(blueprint.configFields.map((f) => f.key));

        for (const providedKey of Object.keys(providedConfig)) {
            if (!allowedKeys.has(providedKey)) {
                throw new BadRequestException(`Champ de configuration inconnu pour "${key}" : "${providedKey}"`);
            }
        }

        for (const field of blueprint.configFields) {
            if (field.required && (providedConfig[field.key] === undefined || providedConfig[field.key] === '')) {
                throw new BadRequestException(`Le champ "${field.label}" est requis pour le service "${blueprint.name}".`);
            }
        }
    }

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
            if (field.secret) secret[field.key] = value;
            else plain[field.key] = value;
        }

        return { plain, secret };
    }
}