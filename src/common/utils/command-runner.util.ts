import { execFile } from 'child_process';
import { promisify } from 'util';

// Promisifies Node.js 'execFile' to allow using async/await syntax instead of traditional callbacks
const execFileAsync = promisify(execFile);

/**
 * Interface representing the result of a child process execution.
 */
export interface CommandResult {
    stdout: string; // Standard output stream
    stderr: string; // Standard error stream
}

/**
 * Custom error class thrown when a CLI command execution fails.
 * Encapsulates execution details for easier debugging and structured logging.
 */
export class CommandFailedError extends Error {
    constructor(
        public readonly command: string,
        public readonly stdout: string,
        public readonly stderr: string,
    ) {
        // Formats error message with command name and captured error output
        super(`Command failed: ${command}\n${stderr || stdout}`);
    }
}

/**
 * Resolves binary executable names across operating systems.
 * Windows requires appending the `.cmd` extension for Node CLI wrappers like pnpm or npx.
 * * @param baseCommand - Target CLI tool ('pnpm' or 'npx').
 * @returns Cross-platform executable string.
 */
function resolveExecutable(baseCommand: 'pnpm' | 'npx'): string {
    return process.platform === 'win32' ? `${baseCommand}.cmd` : baseCommand;
}

/**
 * Safely executes CLI commands asynchronously inside a specified directory.
 * * @param baseCommand - Executable binary ('pnpm' or 'npx').
 * @param args - Array of command-line arguments.
 * @param cwd - Working directory context for execution.
 * @param timeoutMs - Maximum allowed execution duration before process termination.
 * @returns Result object containing stdout and stderr logs.
 * @throws `CommandFailedError` if execution fails or times out.
 */
export async function runCommand(
    baseCommand: 'pnpm' | 'npx',
    args: string[],
    cwd: string,
    timeoutMs: number,
): Promise<CommandResult> {

    const executable = resolveExecutable(baseCommand);

    try {
        // Executes child process asynchronously with safe execution constraints
        const { stdout, stderr } = await execFileAsync(executable, args, {
            cwd,                             // Sets working directory
            timeout: timeoutMs,              // Prevents hanging processes by enforcing a timeout
            maxBuffer: 10 * 1024 * 1024,     // Caps buffer size to 10MB to avoid out-of-memory errors
            windowsHide: true,               // Hides console window on Windows systems
            shell: process.platform === 'win32', // Required on Windows to launch batch files (.cmd)
        });
        
        return { stdout, stderr };
    } catch (error: unknown) {

        const commandError = error as {
            stdout?: string;
            stderr?: string;
            message?: string;
        };

        // Normalizes caught errors into custom CommandFailedError
        throw new CommandFailedError(
            `${baseCommand} ${args.join(' ')}`,
            commandError.stdout ?? '',
            commandError.stderr ?? commandError.message ?? '',
        );
    }
}