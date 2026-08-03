import { generateAuthUserFiles, BlueprintModuleRef } from './generators/auth-user.generator';
import { generateMailingFiles } from './generators/mailing.generator';
import { generateSchedulerFiles } from './generators/scheduler.generator';

type FileGenerator = (
    projectPath: string,
    config: Record<string, unknown>,
) => Promise<BlueprintModuleRef[]>;

export const SERVICE_FILE_GENERATORS: Record<string, FileGenerator> = {
    'auth-user': generateAuthUserFiles,
    mailing: generateMailingFiles,
    scheduler: generateSchedulerFiles,
};