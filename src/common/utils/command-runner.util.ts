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
 * Masks credentials embedded in connection strings (`scheme://user:password@host`) and in
 * `KEY=value` pairs whose key looks secret, so a failing command never writes a password into
 * application logs, generation logs or exception messages.
 */
export function redactSecrets(text: string): string {
    if (!text) return text;
    return text
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:)[^@\s]+@/gi, '$1***@')
        .replace(/\b([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*=)[^\s]+/g, '$1***');
}

/**
 * Custom error class thrown when a CLI command execution fails.
 * Encapsulates execution details for easier debugging and structured logging. Every field is
 * passed through `redactSecrets()` (SEC-014) so it is safe to log or persist.
 */
export class CommandFailedError extends Error {
    public readonly command: string;
    public readonly stdout: string;
    public readonly stderr: string;

    constructor(command: string, stdout: string, stderr: string) {
        const safeCommand = redactSecrets(command);
        const safeStdout = redactSecrets(stdout);
        const safeStderr = redactSecrets(stderr);
        super(`Command failed: ${safeCommand}\n${safeStderr || safeStdout}`);
        this.command = safeCommand;
        this.stdout = safeStdout;
        this.stderr = safeStderr;
    }
}

/**
 * SECURITY FIX (SEC-001): child processes used to receive `{ ...process.env }`, i.e. every
 * secret of the orchestrator (JWT_SECRET, ENCRYPTION_KEY, DATABASE_URL, provisioning URL, SMTP
 * password...). `pnpm install` on a generated project runs third-party install scripts, so any
 * compromised transitive dependency could exfiltrate them. Only the variables below (needed to
 * locate binaries, caches, proxies and CA bundles) are inherited now; everything else must be
 * passed explicitly through `envOverrides`.
 */
const INHERITED_ENV_ALLOWLIST = [
    'PATH',
    'HOME',
    'USER',
    'LANG',
    'LC_ALL',
    'TZ',
    'TMPDIR',
    'TEMP',
    'TMP',
    'SHELL',
    'PNPM_HOME',
    'COREPACK_HOME',
    'COREPACK_ENABLE_DOWNLOAD_PROMPT',
    'XDG_CACHE_HOME',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'npm_config_registry',
    'NPM_CONFIG_REGISTRY',
    'npm_config_cache',
    'NPM_CONFIG_CACHE',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    // Windows essentials for `.cmd` wrappers.
    'SystemRoot',
    'SYSTEMROOT',
    'ComSpec',
    'COMSPEC',
    'PATHEXT',
    'APPDATA',
    'LOCALAPPDATA',
    'USERPROFILE',
    'ProgramData',
    'ProgramFiles',
] as const;

export function buildChildProcessEnv(envOverrides: Record<string, string> = {}): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    for (const key of INHERITED_ENV_ALLOWLIST) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return { ...env, ...envOverrides };
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
            cwd, // Sets working directory
            timeout: timeoutMs, // Prevents hanging processes by enforcing a timeout
            maxBuffer: 10 * 1024 * 1024, // Caps buffer size to 10MB to avoid out-of-memory errors
            windowsHide: true, // Hides console window on Windows systems
            env: buildChildProcessEnv(envOverrides),
            signal,
            ...(useShell && { shell: true }),
        });

        return { stdout, stderr };
    } catch (error: unknown) {
        const commandError = error as CommandExecutionError;

        if (commandError.name === 'AbortError' || commandError.code === 'ABORT_ERR') {
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
