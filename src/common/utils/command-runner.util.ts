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

interface CommandExecutionError {
    name?: string;
    code?: string | number;
    stdout?: string;
    stderr?: string;
    message?: string;
}

/**
 * Resolves binary executable names across operating systems.
 * Windows requires appending the `.cmd` extension for Node CLI wrappers like pnpm or npx.
 * `pg_dump` is a native binary on every platform (no Node wrapper script), so it is never
 * suffixed and never needs the `{ shell: true }` workaround described below.
 * * @param baseCommand - Target CLI tool ('pnpm', 'npx', or 'pg_dump').
 * @returns Cross-platform executable string.
 */
function resolveExecutable(baseCommand: 'pnpm' | 'npx' | 'pg_dump'): string {
    if (baseCommand === 'pg_dump') return baseCommand;
    return process.platform === 'win32' ? `${baseCommand}.cmd` : baseCommand;
}

/**
 * Characters that carry special meaning to `cmd.exe` when a command line is interpreted by a
 * shell (`&`, `|`, `<`, `>`, `^`, `%`, quotes, backticks, newlines, ...). Node's `child_process`
 * has a well-known quirk on Windows: `.cmd`/`.bat` wrapper scripts (which is what `pnpm`/`npx`
 * resolve to) cannot be launched directly by `execFile` without `{ shell: true }` - Windows
 * itself only knows how to run `.exe` binaries without going through a command interpreter.
 *
 * SECURITY FIX: the previous implementation unconditionally set `shell: true` on Windows,
 * which silently re-enables shell metacharacter interpretation for every argument passed to
 * `runCommand` on that platform. Every caller in this codebase currently passes already-
 * validated values (sanitized slugs, absolute paths, package names) as `args`, so there is no
 * known exploitable path today - but this utility is depended on by future generator code, and
 * a single caller that ever forwards a less-trusted string would silently reintroduce command
 * injection on Windows. As a defense-in-depth guard that costs nothing on the happy path, we
 * validate every argument against this denylist before shell mode is used, and refuse to run
 * the command at all if any argument looks like it could break out of its own token.
 */
const SHELL_METACHARACTER_PATTERN = /[&|<>^%"`\r\n]/;

/**
 * Rejects any command-line argument containing a Windows shell metacharacter.
 * Only relevant when `{ shell: true }` is in effect (Windows), since on POSIX platforms
 * `execFile` never invokes a shell and arguments are passed as an opaque array regardless of
 * their content.
 *
 * @param args - The argument list about to be passed to `execFile`.
 * @throws {Error} if any argument contains a character that could alter how `cmd.exe` parses
 *   the resulting command line.
 */
function assertArgsAreShellSafe(args: string[]): void {
    for (const arg of args) {
        if (SHELL_METACHARACTER_PATTERN.test(arg)) {
            throw new Error(
                `Refusing to execute command: argument contains a disallowed shell metacharacter ("${arg}").`,
            );
        }
    }
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
    baseCommand: 'pnpm' | 'npx' | 'pg_dump',
    args: string[],
    cwd: string,
    timeoutMs: number,
    envOverrides: Record<string, string> = {},
    signal?: AbortSignal,
): Promise<CommandResult> {

    const executable = resolveExecutable(baseCommand);
    // `pg_dump` is a native binary launched directly, on every platform - the shell-wrapper
    // workaround below exists only for the `pnpm.cmd`/`npx.cmd` Node script wrappers on
    // Windows, so it must never apply to it (which also means its arguments - notably a
    // connection URI containing '@', ':', '/' - never go through shell parsing at all).
    const useShell = process.platform === 'win32' && baseCommand !== 'pg_dump';

    // Defense in depth: only ever enable shell mode after confirming no argument could be
    // (mis)interpreted as additional shell syntax. See `assertArgsAreShellSafe` above.
    if (useShell) {
        assertArgsAreShellSafe(args);
    }

    try {
        // Executes child process asynchronously with safe execution constraints
        const { stdout, stderr } = await execFileAsync(executable, args, {
            cwd,                             // Sets working directory
            timeout: timeoutMs,              // Prevents hanging processes by enforcing a timeout
            maxBuffer: 10 * 1024 * 1024,     // Caps buffer size to 10MB to avoid out-of-memory errors
            windowsHide: true,               // Hides console window on Windows systems
            env: { ...process.env, ...envOverrides },
            signal,
            ...(useShell && { shell: true }),
        });
        
        return { stdout, stderr };
    } catch (error: unknown) {

        const commandError = error as CommandExecutionError;

        if (
            commandError.name === 'AbortError' ||
            commandError.code === 'ABORT_ERR'
        ) {
            throw new CommandCancelledError();
        }

        // Normalizes caught errors into custom CommandFailedError
        throw new CommandFailedError(
            `${baseCommand} ${args.join(' ')}`,
            commandError.stdout ?? '',
            commandError.stderr ?? commandError.message ?? '',
        );
    }
}

export class CommandCancelledError extends Error {
    constructor() {
        super('Command cancelled.');
    }
}