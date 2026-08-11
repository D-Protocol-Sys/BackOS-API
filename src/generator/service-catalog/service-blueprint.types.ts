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
}

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
    /** Map of npm package dependencies and versions injected into `package.json` */
    pnpmDependencies: Record<string, string>;
    /** Array of configuration inputs required to operate this service */
    configFields: ServiceConfigField[];
    /** Optional Prisma Schema DSL snippet appended to the target database schema */
    prismaModels?: string;
}