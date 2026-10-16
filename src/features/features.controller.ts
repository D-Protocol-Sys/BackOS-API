import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { FeaturesService } from './features.service';
import type { FeatureInfo } from './feature.types';

/**
 * Lets the front end know which optional features this server runs, so that it can show or hide
 * the matching screens. Any signed-in user may call it: it reveals nothing sensitive.
 */
@ApiTags('Features')
@ApiBearerAuth('access-token')
@Controller('features')
export class FeaturesController {
    constructor(private readonly features: FeaturesService) {}

    @Get()
    list(): { features: FeatureInfo[] } {
        return { features: this.features.list() };
    }
}
