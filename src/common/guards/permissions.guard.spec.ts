import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';

/**
 * PermissionsGuard est le seul rempart entre "authentifié" et "autorisé" sur chaque route
 * protégée par @RequirePermissions() - c'est la surface la plus sensible du projet
 * (RBAC/ABAC) et pourtant elle n'avait aucun test avant celui-ci. Priorité n°1 de l'audit
 * de couverture (voir docs/TESTS_COVERAGE_AUDIT.md).
 */
describe('PermissionsGuard', () => {
    let reflector: Reflector;
    let guard: PermissionsGuard;

    beforeEach(() => {
        reflector = new Reflector();
        guard = new PermissionsGuard(reflector);
    });

    function makeContext(userPermissions: string[] | undefined): ExecutionContext {
        const request = { user: userPermissions === undefined ? undefined : { permissions: userPermissions } };
        return {
            getHandler: () => ({}),
            getClass: () => ({}),
            switchToHttp: () => ({ getRequest: () => request }),
        } as unknown as ExecutionContext;
    }

    it("autorise l'accès quand aucune permission n'est requise sur la route", () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
        expect(guard.canActivate(makeContext([]))).toBe(true);
    });

    it("autorise l'accès quand le tableau de permissions requises est vide", () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
        expect(guard.canActivate(makeContext([]))).toBe(true);
    });

    it("autorise quand l'utilisateur possède TOUTES les permissions requises", () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['users:read', 'users:update']);
        expect(guard.canActivate(makeContext(['users:read', 'users:update', 'roles:read']))).toBe(true);
    });

    it('refuse (403) quand il manque UNE SEULE des permissions requises', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['users:read', 'users:delete']);
        expect(() => guard.canActivate(makeContext(['users:read']))).toThrow(ForbiddenException);
    });

    it('refuse quand request.user est absent (ne doit jamais planter, juste refuser)', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['users:read']);
        expect(() => guard.canActivate(makeContext(undefined))).toThrow(ForbiddenException);
    });

    it('refuse quand request.user.permissions est absent', () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['users:read']);
        const request = { user: {} };
        const context = {
            getHandler: () => ({}),
            getClass: () => ({}),
            switchToHttp: () => ({ getRequest: () => request }),
        } as unknown as ExecutionContext;
        expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('lit les métadonnées handler ET classe (getAllAndOverride) avec les bonnes cibles', () => {
        const spy = jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
        const handler = () => {};
        const klass = class {};
        const context = {
            getHandler: () => handler,
            getClass: () => klass,
            switchToHttp: () => ({ getRequest: () => ({ user: { permissions: [] } }) }),
        } as unknown as ExecutionContext;

        guard.canActivate(context);

        expect(spy).toHaveBeenCalledWith(expect.any(String), [handler, klass]);
    });
});
