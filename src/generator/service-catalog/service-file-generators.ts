import { generateAuthUserFiles, BlueprintModuleRef } from './generators/auth-user.generator';
import { generateMailingFiles } from './generators/mailing.generator';
import { generateSchedulerFiles } from './generators/scheduler.generator';

/**
 * Function type signature representing a blueprint file generator.
 * * Receives the target generated project root directory path and service configuration options,
 * and asynchronously returns an array of module references to be registered in NestJS.
 * * @param projectPath - Absolute or relative path to the generated project root directory.
 * @param config - Service configuration key-value dictionary.
 * @returns Promise resolving to an array of generated NestJS module references (`BlueprintModuleRef[]`).
 */
type FileGenerator = (
    projectPath: string,
    config: Record<string, unknown>,
) => Promise<BlueprintModuleRef[]>;

/**
 * Mapping table associating service keys (e.g., 'auth-user', 'mailing', 'scheduler')
 * with their corresponding file code generator functions.
 * * Enables dynamic invocation during application build / generation pipelines based on 
 * activated platform service keys.
 */
export const SERVICE_FILE_GENERATORS: Record<string, FileGenerator> = {
    'auth-user': generateAuthUserFiles,
    mailing: generateMailingFiles,
    scheduler: generateSchedulerFiles,
};