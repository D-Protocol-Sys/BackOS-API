import { Injectable, OnApplicationShutdown } from '@nestjs/common';

/**
 * Registry managing execution cancellation for async generation tasks.
 * Educational Note: Uses native `AbortController` instances stored in an in-memory `Map` 
 * to send cancellation signals to long-running tasks across asynchronous boundaries.
 */
@Injectable()
export class GenerationCancellationRegistry implements OnApplicationShutdown {
    private readonly controllers = new Map<string, AbortController>();
    private shuttingDown = false;

    /** True once the application started shutting down (aborts are not user cancellations). */
    isShuttingDown(): boolean {
        return this.shuttingDown;
    }

    /**
     * Instantiates and registers a new AbortController for a specific generation process.
     */
    register(generationId: string): AbortController {
        const controller = new AbortController();
        this.controllers.set(generationId, controller);
        return controller;
    }

    /**
     * Retrieves an active AbortController by generation ID.
     */
    get(generationId: string): AbortController | undefined {
        return this.controllers.get(generationId);
    }

    /**
     * Removes the controller from the registry upon task completion or termination.
     */
    clear(generationId: string): void {
        this.controllers.delete(generationId);
    }

    /**
     * RELIABILITY FIX (GEN-009): on shutdown (SIGTERM with shutdown hooks enabled) the running
     * `pnpm`/`prisma` child processes are aborted instead of being left orphaned; the job is
     * then picked up again by the boot-time reconciliation.
     */
    onApplicationShutdown(): void {
        this.shuttingDown = true;
        for (const controller of this.controllers.values()) {
            controller.abort();
        }
        this.controllers.clear();
    }
}
