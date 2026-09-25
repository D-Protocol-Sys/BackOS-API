/**
 * Interface defining a configuration field required by a pluggable service.
 * Used by front-end forms and validation pipelines to dynamically render 
 * and validate service settings (e.g., API keys, port numbers, passwords).
 */
export interface ServiceConfigField {
    /** Unique configuration key name (e.g., "smtpHost", "jwtSecret") */
    key: string;
    /** Human-readable label display name for forms and UI dashboards */
    label: string;
    /** Indicates if the value contains sensitive data (e.g., masked input field in UI) */
    secret: boolean;
    /** Specifies whether this configuration property is mandatory */
    required: boolean;
    /** Optional sample value or hint text to assist user input in forms */
    placeholder?: string;
    /**
     * Kind of input the front-end should render, and the kind of value the API accepts:
     *  - `'string'`  (default) - free text
     *  - `'boolean'` - a toggle; `true` / `false` (the strings `"true"` / `"false"` are also accepted
     *                  and normalised to real booleans before being stored)
     *  - `'number'`  - a numeric input; numeric strings are accepted and normalised to numbers
     */
    type?: 'string' | 'boolean' | 'number';
    /** Optional longer explanation shown under the field in forms (what it changes, when to enable it). */
    description?: string;
    /**
     * INTERNAL field: never shown in forms, never accepted from the caller of
     * `POST /platforms/:id/services`, and carried over untouched whenever the service is
     * re-enabled with a new configuration. Written only by the platform itself (a generated
     * secret, or a value edited through a dedicated endpoint such as the profile-fields one).
     */
    system?: boolean;
    /**
     * Only meaningful together with `system`: a random 256-bit secret is generated the first time
     * the service is enabled, and kept for the lifetime of the service on that platform.
     */
    autoGenerate?: boolean;
}

/**
 * Prisma models a service contributes to the generated project's `schema.prisma`.
 * Either a fixed snippet, or a function receiving the service's FULL configuration - for services
 * whose tables depend on that configuration (e.g. the external-user profile table of Auth & User,
 * whose columns are the profile fields defined by the platform owner).
 */
export type ServicePrismaModels = string | ((config: Record<string, unknown>) => string);

/**
 * Interface representing a service blueprint manifest.
 * Serves as the master contract for dynamically injected platform features 
 * (such as Auth, Mailing, or Scheduler modules).
 */
export interface ServiceBlueprint {
    /** Unique identifier key for the service module (e.g., "auth-user", "mailing") */
    key: string;
    /** Display name of the service module */
    name: string;
    /** Detailed description of the feature set provided by this module */
    description: string;
    /**
     * Keys of the services that MUST already be active on the platform before this one can be
     * enabled (e.g. `['mailing']` for Auth & User, which sends its OTP codes through it).
     * Enforced when enabling this service, when disabling a service others rely on, and again at
     * generation time. The front-end can use it to grey out a service until its prerequisites are on.
     */
    dependsOn?: string[];
    /** Map of npm package dependencies and versions injected into `package.json` */
    pnpmDependencies: Record<string, string>;
    pnpmDevDependencies?: Record<string, string>;
    /** Array of configuration inputs required to operate this service */
    configFields: ServiceConfigField[];
    /** Optional Prisma Schema DSL appended to the target database schema (fixed snippet or config-driven function) */
    prismaModels?: ServicePrismaModels;
}
