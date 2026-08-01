import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CommandResult {
    stdout: string;
    stderr: string;
}

export class CommandFailedError extends Error {
    constructor(
        public readonly command: string,
        public readonly stdout: string,
        public readonly stderr: string,
    ) {
        super(`Commande échouée : ${command}\n${stderr || stdout}`);
    }
}

function resolveExecutable(baseCommand: 'pnpm' | 'npx'): string {
    return process.platform === 'win32' ? `${baseCommand}.cmd` : baseCommand;
}

export async function runCommand(
    baseCommand: 'pnpm' | 'npx',
    args: string[],
    cwd: string,
    timeoutMs: number,
): Promise<CommandResult> {

    const executable = resolveExecutable(baseCommand);

    try {
        const { stdout, stderr } = await execFileAsync(executable, args, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            windowsHide: true,
        });
        return { stdout, stderr };
    } catch (error: any) {
        throw new CommandFailedError(
            `${baseCommand} ${args.join(' ')}`,
            error.stdout ?? '',
            error.stderr ?? error.message ?? '',
        );
    }
}