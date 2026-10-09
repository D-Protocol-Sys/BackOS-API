import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * OBSERVABILITY (OPS-007 / SEC-027): a request id is attached to every HTTP request (reusing a
 * well-formed incoming `X-Request-Id`, e.g. from Traefik), echoed in the response, and made
 * available anywhere in the call chain (audit log entries, logs) without passing it around.
 */
const storage = new AsyncLocalStorage<{ requestId: string }>();
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/;

export function requestContextMiddleware(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id');
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', requestId);
    storage.run({ requestId }, () => next());
}

export function currentRequestId(): string | undefined {
    return storage.getStore()?.requestId;
}
