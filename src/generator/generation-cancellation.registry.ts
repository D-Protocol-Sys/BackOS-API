import { Injectable } from '@nestjs/common';

/**
 * Registry managing execution cancellation for async generation tasks.
 * Educational Note: Uses native `AbortController` instances stored in an in-memory `Map` 
 * to send cancellation signals to long-running tasks across asynchronous boundaries.
 */
@Injectable()
export class GenerationCancellationRegistry {
    private readonly controllers = new Map<string, AbortController>();

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
}