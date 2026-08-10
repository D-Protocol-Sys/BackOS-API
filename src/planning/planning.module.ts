import { Module } from '@nestjs/common';
import { PlanningService } from './planning.service';
import { PersonalPlanningController } from './personal-planning.controller';
import { PlatformPlanningController } from './platform-planning.controller';

@Module({

    controllers: [
        PersonalPlanningController,
        PlatformPlanningController
    ],

    providers: [PlanningService],

    exports: [PlanningService],

})

export class PlanningModule {}
