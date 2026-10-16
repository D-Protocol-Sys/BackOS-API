import { Module } from '@nestjs/common';
import { PlatformAccessModule } from '../platforms/platform-access.module';
import { PlanningService } from './planning.service';
import { PlanningProgramService } from './planning-program.service';
import { PersonalPlanningController } from './personal-planning.controller';
import { PlatformPlanningController } from './platform-planning.controller';
import { PersonalPlanningProgramController } from './personal-planning-program.controller';
import { PlatformPlanningProgramController } from './platform-planning-program.controller';

@Module({
    imports: [PlatformAccessModule],

    controllers: [
        PersonalPlanningController,
        PlatformPlanningController,
        PersonalPlanningProgramController,
        PlatformPlanningProgramController,
    ],

    providers: [PlanningService, PlanningProgramService],

    exports: [PlanningService, PlanningProgramService],
})
export class PlanningModule {}
