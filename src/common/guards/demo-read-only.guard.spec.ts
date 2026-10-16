import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DemoReadOnlyGuard } from './demo-read-only.guard';

function guardFor(demoEmail?: string) {
    const config = {
        get: (key: string) => (key === 'DEMO_WORKEMAIL' ? demoEmail : undefined),
    } as unknown as ConfigService;
    return new DemoReadOnlyGuard(config);
}

function contextFor(request: { method: string; path?: string; user?: { email?: string } }): ExecutionContext {
    return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

describe('DemoReadOnlyGuard', () => {
    const demo = { email: 'demo@example.com' };

    it('lets the demo account read', () => {
        for (const method of ['GET', 'HEAD', 'OPTIONS']) {
            expect(
                guardFor('demo@example.com').canActivate(contextFor({ method, path: '/api/platforms', user: demo })),
            ).toBe(true);
        }
    });

    it('refuses every write made by the demo account', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            expect(() =>
                guardFor('demo@example.com').canActivate(contextFor({ method, path: '/api/messages', user: demo })),
            ).toThrow(ForbiddenException);
        }
    });

    it('compares the e-mail case-insensitively', () => {
        expect(() =>
            guardFor('Demo@Example.com').canActivate(
                contextFor({ method: 'DELETE', path: '/api/users/me', user: { email: 'DEMO@example.COM' } }),
            ),
        ).toThrow(ForbiddenException);
    });

    it('still lets the demo account sign out and refresh its session', () => {
        expect(
            guardFor('demo@example.com').canActivate(
                contextFor({ method: 'POST', path: '/api/auth/logout', user: demo }),
            ),
        ).toBe(true);
        expect(
            guardFor('demo@example.com').canActivate(
                contextFor({ method: 'POST', path: '/api/auth/refresh', user: demo }),
            ),
        ).toBe(true);
    });

    it('does not touch anyone else', () => {
        expect(
            guardFor('demo@example.com').canActivate(
                contextFor({ method: 'POST', path: '/api/messages', user: { email: 'owner@example.com' } }),
            ),
        ).toBe(true);
    });

    it('does not touch unauthenticated routes (login, public forms)', () => {
        expect(guardFor('demo@example.com').canActivate(contextFor({ method: 'POST', path: '/api/auth/login' }))).toBe(
            true,
        );
    });

    it('is inactive when no demo account is configured', () => {
        expect(guardFor(undefined).canActivate(contextFor({ method: 'DELETE', path: '/api/x', user: demo }))).toBe(
            true,
        );
    });
});
