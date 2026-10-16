import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

@Controller()
export class AppController {
    constructor(private readonly appService: AppService) {}

    @Public()
    @Get()
    getInfo() {
        return this.appService.getInfo();
    }

    /**
     * OPS FIX: the endpoint used to answer 200 even when the database was unreachable, so the
     * container healthcheck, Traefik and any uptime monitor kept considering a broken instance
     * healthy. A degraded instance now answers 503 (the body is unchanged).
     */
    @Public()
    @Get('health')
    async getHealth(@Res({ passthrough: true }) res: Response) {
        const health = await this.appService.getHealth();
        if (health.status !== 'ok') {
            res.status(HttpStatus.SERVICE_UNAVAILABLE);
        }
        return health;
    }
}
