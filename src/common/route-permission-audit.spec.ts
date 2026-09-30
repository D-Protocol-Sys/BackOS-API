import * as fs from 'fs';
import * as path from 'path';

/**
 * SECURITY FIX (audit #8 - medium): `PermissionsGuard` defaults to *allowing* access when a
 * route carries no `@RequirePermissions(...)` metadata (see that guard's own comment - this is
 * intentional, since a large number of routes in this codebase are scoped by identity/ownership
 * via manual, in-service checks - e.g. `PlanningService.assertCanEditPlatformPlanning()` -
 * rather than by a flat permission key). That design is reasonable, but it has a real, growing
 * failure mode: a future route added without EITHER `@RequirePermissions(...)`, `@Public()`,
 * OR a deliberate in-service check would silently be reachable by any authenticated user, and
 * nothing before this test would ever flag it.
 *
 * Rather than changing `PermissionsGuard`'s default (which would break every legitimately
 * manually-checked route below), this test enumerates EVERY route across EVERY
 * `*.controller.ts` file and requires each one to be consciously categorized as exactly one of:
 *   1. `@RequirePermissions(...)` - guarded by `PermissionsGuard`.
 *   2. `@Public()` - deliberately unauthenticated.
 *   3. Present in `MANUALLY_CHECKED_ROUTES` below, with a one-line reason.
 *
 * A route matching none of the three fails this test. This is a STATIC, textual scan (regex
 * over source, not NestJS's runtime `Reflector`) - deliberately simple and dependency-free so it
 * can run without bootstrapping the full application (which needs a live database connection
 * and the generated `@prismamodels/*` packages, neither available in a plain `pnpm test` run).
 * It is a safety net that forces a conscious decision on every new route, not a re-verification
 * that every existing manual check is itself correct - see each controller's own service layer
 * for that.
 */

const CONTROLLERS_ROOT = path.resolve(__dirname, '..');

/**
 * Routes that intentionally have NEITHER `@RequirePermissions(...)` NOR `@Public()`, together
 * with why that is fine. Grouped by controller file (relative to `src/`), method name as it
 * appears in the source (unique per file). Adding a new entry here should be a deliberate,
 * reviewed decision - not a way to silence this test.
 */
const MANUALLY_CHECKED_ROUTES: Record<string, Record<string, string>> = {
    'entities/entities.controller.ts': {
        list: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        getById: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        create: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        update: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        delete: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        setSchedulable: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        archive: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        restore: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
        setAuthProtection: 'Scoped via CurrentUser + platform membership checked in EntitiesService.',
    },
    'fields/fields.controller.ts': {
        list: 'Scoped via CurrentUser + platform membership checked in FieldsService.',
        create: 'Scoped via CurrentUser + platform membership checked in FieldsService.',
        update: 'Scoped via CurrentUser + platform membership checked in FieldsService.',
        delete: 'Scoped via CurrentUser + platform membership checked in FieldsService.',
        archive: 'Scoped via CurrentUser + platform membership checked in FieldsService.',
        restore: 'Scoped via CurrentUser + platform membership checked in FieldsService.',
    },
    'enum-definitions/enum-definitions.controller.ts': {
        list: 'Scoped via CurrentUser + platform membership checked in EnumDefinitionsService.',
        create: 'Scoped via CurrentUser + platform membership checked in EnumDefinitionsService.',
        update: 'Scoped via CurrentUser + platform membership checked in EnumDefinitionsService.',
        delete: 'Scoped via CurrentUser + platform membership checked in EnumDefinitionsService.',
    },
    'relations/relations.controller.ts': {
        list: 'Scoped via CurrentUser + platform membership checked in RelationsService.',
        create: 'Scoped via CurrentUser + platform membership checked in RelationsService.',
        delete: 'Scoped via CurrentUser + platform membership checked in RelationsService.',
    },
    'files/files.controller.ts': {
        upload: 'Scoped via CurrentUser; target entity/platform membership checked in FilesService.',
        getMetadata: 'Scoped via CurrentUser; ownership/membership checked in FilesService.',
        download: 'Scoped via CurrentUser; ownership/membership checked in FilesService.',
        delete: 'Scoped via CurrentUser; ownership/membership checked in FilesService.',
    },
    'generator/generator.controller.ts': {
        triggerGeneration: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        cancelGeneration: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        approveGeneration: 'Scoped via CurrentUser; only the platform owner (or a global GENERATOR_EXECUTE holder) may approve, checked in GeneratorController.assertOwnerOrGlobalGenerator().',
        rejectGeneration: 'Scoped via CurrentUser; only the platform owner (or a global GENERATOR_EXECUTE holder) may reject, checked in GeneratorController.assertOwnerOrGlobalGenerator().',
        listGenerations: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        getGeneration: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        startRuntime: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        stopRuntime: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        getRuntimeStatus: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        getRuntimeLogs: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        getApiManifest: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
        exportApiManifest: 'Scoped via CurrentUser + platform ownership/permission checked in GeneratorService.',
    },
    'generator/platform-services.controller.ts': {
        list: 'Scoped via CurrentUser + platform membership checked in PlatformServicesService.',
        enable: 'Scoped via CurrentUser + platform membership checked in PlatformServicesService.',
        disable: 'Scoped via CurrentUser + platform membership checked in PlatformServicesService.',
        getProfileFields: 'Scoped via CurrentUser + platform membership checked in PlatformServicesService.',
        setProfileFields: 'Scoped via CurrentUser + platform membership / PLATFORM_UPDATE checked in PlatformServicesService.',
    },
    'generator/service-catalog.controller.ts': {
        list: 'Static, non-sensitive reference data (the service catalog) - authentication alone (global JwtAuthGuard) is intentionally sufficient; nothing here is user- or platform-specific.',
    },
    'messages/messages.controller.ts': {
        listConversations: 'Scoped via CurrentUser; conversation participation checked in MessagesService.',
        getUnreadCount: 'Scoped via CurrentUser to the caller\'s own unread count only.',
        getMessages: 'Scoped via CurrentUser; conversation participation checked in MessagesService.',
        sendToConversation: 'Scoped via CurrentUser; conversation participation checked in MessagesService.',
        sendDirectMessage: 'Scoped via CurrentUser as the sender; recipient validity checked in MessagesService.',
        deleteMessage: 'Scoped via CurrentUser; conversation participation checked, and "everyone" scope additionally requires being the sender, in MessagesService.deleteMessage().',
    },
    'planning/personal-planning.controller.ts': {
        create: "Personal planning: always scoped to the caller's own userId, never another user's.",
        list: "Personal planning: always scoped to the caller's own userId, never another user's.",
        getById: "Personal planning: always scoped to the caller's own userId, never another user's.",
        update: "Personal planning: always scoped to the caller's own userId, never another user's.",
        delete: "Personal planning: always scoped to the caller's own userId, never another user's.",
    },
    'planning/platform-planning.controller.ts': {
        create: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanEditPlatformPlanning().',
        list: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanViewPlatformPlanning().',
        getResponsible: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanViewPlatformPlanning() (read-side counterpart to reassignResponsible).',
        reassignResponsible: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanEditPlatformPlanning() (audit #1/#5 follow-up).',
        update: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanEditPlatformPlanning().',
        delete: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanEditPlatformPlanning().',
        addAssignee: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanEditPlatformPlanning().',
        removeAssignee: 'Scoped via CurrentUser + platform membership checked in PlanningService.assertCanEditPlatformPlanning().',
    },
    'users/users.controller.ts': {
        getMe: "Always scoped to the caller's own userId via CurrentUser - never another user's data.",
        updateMe: "Always scoped to the caller's own userId via CurrentUser - never another user's data.",
        getMyProfileDetails: "Always scoped to the caller's own userId via CurrentUser - never another user's data.",
        updateMyProfileDetails: "Always scoped to the caller's own userId via CurrentUser - never another user's data.",
        exportMe: "Always scoped to the caller's own userId via CurrentUser - never another user's data.",
        exportUser: "GDPR export of another user: allowed only for a global USERS_EXPORT holder or the owner/ADMIN of a platform the target belongs to, checked in UsersService.exportUserDataAs().",
        deleteMe: "Always scoped to the caller's own userId via CurrentUser, and (audit #3) now additionally requires a fresh step-up TOTP code.",
        uploadMyAvatar: "Always scoped to the caller's own userId via CurrentUser - never another user's data.",
        getAvatar: 'Any authenticated user may view any team member\'s avatar - equivalent to a company directory photo, not sensitive data (global JwtAuthGuard is sufficient).',
    },
    'auth/auth.controller.ts': {
        logout: 'Requires a valid access token (global JwtAuthGuard); revokes only the caller\'s own refresh token, never another user\'s.',
    },
    'projects/projects.controller.ts': {
        list: 'Scoped via CurrentUser + manager/visibility checked in ProjectsService.list().',
        getById: 'Scoped via CurrentUser + manager/visibility checked in ProjectsService.getById().',
        update: 'Scoped via CurrentUser + manager/visibility checked in ProjectsService.update().',
        remove: 'Scoped via CurrentUser + manager/visibility checked in ProjectsService.delete().',
    },
    'platforms/platform-roles.controller.ts': {
        list: 'Scoped via CurrentUser + ownership/membership checked in PlatformRolesService.list().',
        catalog: 'Scoped via CurrentUser + platform visibility checked in PlatformRolesService.catalog(); only flags what the caller may grant.',
        create: 'Scoped via CurrentUser + platform.manage-roles permission and the permission-ceiling rule checked in PlatformRolesService.create().',
        update: 'Scoped via CurrentUser + platform.manage-roles permission and the permission-ceiling rule checked in PlatformRolesService.update().',
        remove: 'Scoped via CurrentUser + platform.manage-roles permission checked in PlatformRolesService.remove().',
    },
    'platforms/platforms.controller.ts': {
        getMyAccess: "Always scoped to the caller's own userId via CurrentUser - never reveals another user's access; visibility checked in PlatformsService.getMyAccess().",
        list: 'Scoped via CurrentUser; PlatformsService.list() returns only platforms the caller owns or is a member of.',
        getById: 'Scoped via CurrentUser + ownership/membership checked in PlatformsService.getById().',
        update: 'Scoped via CurrentUser + ownership/membership checked in PlatformsService.update().',
        archive: 'Scoped via CurrentUser + ownership checked in PlatformsService.archive().',
        restore: 'Scoped via CurrentUser + ownership checked in PlatformsService.restore().',
        purge: 'Scoped via CurrentUser + ownership checked in PlatformsService.purge().',
        transferOwnership: 'Scoped via CurrentUser + current-owner check in PlatformsService.transferOwnership().',
        listMembers: 'Scoped via CurrentUser + ownership/membership checked in PlatformsService.listMembers().',
        addMember: 'Scoped via CurrentUser + platform.manage-members permission and role-grant ceiling checked in PlatformsService.addMember().',
        updateMemberRole: 'Scoped via CurrentUser + ownership/admin-membership checked in PlatformsService.updateMemberRole().',
        removeMember: 'Scoped via CurrentUser + ownership/admin-membership checked in PlatformsService.removeMember().',
        confirmMemberRemoval: 'Scoped via CurrentUser; only the affected member or a platform admin may confirm, checked in PlatformsService.',
        cancelMemberRemoval: 'Scoped via CurrentUser; only the affected member or a platform admin may cancel, checked in PlatformsService.',
        getChannel: 'Scoped via CurrentUser + platform membership checked in MessagesService.getOrCreatePlatformChannel().',
    },
};

/** Matches `@Get(...)`, `@Post(...)`, `@Patch(...)`, `@Put(...)`, `@Delete(...)` decorator lines. */
const ROUTE_DECORATOR_RE = /^\s*@(Get|Post|Patch|Put|Delete)\(([^)]*)\)\s*$/;

/** Matches the method name on the line(s) immediately following a route decorator block. */
const METHOD_NAME_RE = /^\s*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/;

/**
 * Collapses multi-line decorator calls (chiefly multi-line Swagger decorators like
 * `@ApiResponse({ status: 201, ... })` spanning several lines) into a single logical line, by
 * tracking bracket balance starting from each line that opens with a decorator (`@Whatever(`).
 * Deliberately scoped to ONLY decorator-opening lines (not merged generically across the whole
 * file) - merging on bracket balance file-wide would be fragile against unbalanced parens
 * appearing in ordinary prose inside JSDoc comments (e.g. "see the docs (linked above" without
 * a closing paren on the same line), silently swallowing unrelated lines into one buffer. Every
 * other line (JSDoc, method bodies, non-decorator statements) passes through untouched.
 */
function toLogicalLines(rawLines: string[]): string[] {
    const logical: string[] = [];
    let i = 0;

    while (i < rawLines.length) {
        const trimmed = rawLines[i].trim();

        if (trimmed.startsWith('@')) {
            let buffer = rawLines[i];
            let depth = 0;
            for (const char of rawLines[i]) {
                if (char === '(' || char === '{' || char === '[') depth++;
                if (char === ')' || char === '}' || char === ']') depth--;
            }

            let j = i;
            while (depth > 0 && j + 1 < rawLines.length) {
                j++;
                buffer += ` ${rawLines[j].trim()}`;
                for (const char of rawLines[j]) {
                    if (char === '(' || char === '{' || char === '[') depth++;
                    if (char === ')' || char === '}' || char === ']') depth--;
                }
            }

            logical.push(buffer);
            i = j + 1;
        } else {
            logical.push(rawLines[i]);
            i++;
        }
    }

    return logical;
}

interface DiscoveredRoute {
    file: string;
    httpMethod: string;
    routePath: string;
    methodName: string;
    hasRequirePermissions: boolean;
    hasPublic: boolean;
}

/**
 * Parses a single controller file into its list of routes, using a small state machine over
 * the decorator lines immediately preceding each handler method. This intentionally does not
 * attempt to be a full TypeScript parser - it only needs to answer "does this route decorator
 * block also contain @RequirePermissions or @Public", which a line-based scan handles reliably
 * given this codebase's consistent decorator-stacking style (verified across all controllers).
 */
function parseControllerRoutes(filePath: string): DiscoveredRoute[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = toLogicalLines(content.split(/\r?\n/));
    const routes: DiscoveredRoute[] = [];

    for (let i = 0; i < lines.length; i++) {
        const routeMatch = lines[i].match(ROUTE_DECORATOR_RE);
        if (!routeMatch) continue;

        const [, httpMethod, rawArg] = routeMatch;
        const routePath = rawArg.trim().replace(/^['"`]|['"`]$/g, '');

        // The route decorator (`@Get()`, `@Post()`, ...) can appear anywhere within its
        // method's contiguous decorator block - some controllers in this codebase put
        // `@RequirePermissions(...)` BEFORE the route decorator (e.g. `roles.controller.ts`),
        // others put it AFTER (e.g. `clients.controller.ts`, interleaved with `@Api*(...)`
        // Swagger decorators). So both directions must be scanned: backward to the start of
        // the block, and forward to the handler method itself.
        let hasRequirePermissions = false;
        let hasPublic = false;

        for (let j = i - 1; j >= 0; j--) {
            const line = lines[j].trim();
            if (line.startsWith('@RequirePermissions(')) hasRequirePermissions = true;
            if (line.startsWith('@Public(')) hasPublic = true;

            const isDecoratorOrComment =
                line.startsWith('@') || line.startsWith('*') || line.startsWith('/**') || line === '';
            if (!isDecoratorOrComment) break;
        }

        let methodName = '';
        for (let k = i + 1; k < lines.length; k++) {
            const trimmed = lines[k].trim();
            if (trimmed.startsWith('@RequirePermissions(')) hasRequirePermissions = true;
            if (trimmed.startsWith('@Public(')) hasPublic = true;
            if (trimmed.startsWith('@')) continue;
            const nameMatch = trimmed.match(METHOD_NAME_RE);
            if (nameMatch) {
                methodName = nameMatch[1];
            }
            break;
        }

        routes.push({
            file: filePath,
            httpMethod,
            routePath,
            methodName,
            hasRequirePermissions,
            hasPublic,
        });
    }

    return routes;
}

function findControllerFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            results.push(...findControllerFiles(fullPath));
        } else if (entry.isFile() && entry.name.endsWith('.controller.ts') && !entry.name.endsWith('.spec.ts')) {
            results.push(fullPath);
        }
    }
    return results;
}

describe('Route permission audit (audit #8)', () => {
    const controllerFiles = findControllerFiles(CONTROLLERS_ROOT);

    it('a bien trouvé des fichiers *.controller.ts à analyser (garde-fou anti faux-positif)', () => {
        expect(controllerFiles.length).toBeGreaterThan(10);
    });

    for (const filePath of controllerFiles) {
        const relativeFile = path.relative(CONTROLLERS_ROOT, filePath).replace(/\\/g, '/');

        it(`chaque route de ${relativeFile} est soit @RequirePermissions, soit @Public, soit documentée comme vérifiée manuellement`, () => {
            const routes = parseControllerRoutes(filePath);
            const allowlistForFile = MANUALLY_CHECKED_ROUTES[relativeFile] || {};

            const uncategorized = routes.filter((route) => {
                if (route.hasRequirePermissions || route.hasPublic) return false;
                return !(route.methodName in allowlistForFile);
            });

            if (uncategorized.length > 0) {
                const details = uncategorized
                    .map((r) => `  - ${r.httpMethod}('${r.routePath}') -> ${r.methodName || '<nom introuvable>'}()`)
                    .join('\n');
                throw new Error(
                    `Route(s) sans @RequirePermissions, @Public, ni entrée dans MANUALLY_CHECKED_ROUTES ` +
                    `pour ${relativeFile}:\n${details}\n\n` +
                    `Ajoutez soit un décorateur, soit une entrée documentée et justifiée dans ` +
                    `MANUALLY_CHECKED_ROUTES (route-permission-audit.spec.ts).`,
                );
            }
        });
    }
});
