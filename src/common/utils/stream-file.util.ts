import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import type { Response } from 'express';
import { Logger } from '@nestjs/common';

const logger = new Logger('StreamFile');

/**
 * RELIABILITY FIX (FILE-003): `fs.createReadStream(path).pipe(res)` without an 'error' listener
 * crashed the whole Node process when the file disappeared between the existence check and the
 * read (EventEmitter throws on an unhandled 'error'). `pipeline` propagates the error instead,
 * which is answered with a 404 when nothing has been sent yet.
 */
export async function streamFileToResponse(filePath: string, res: Response): Promise<void> {
    try {
        await pipeline(fs.createReadStream(filePath), res);
    } catch (error) {
        logger.warn(`Streaming "${filePath}" failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) {
            res.status(404).json({ statusCode: 404, message: 'File missing from physical storage.' });
        } else {
            res.destroy();
        }
    }
}
