import { Module } from '@nestjs/common';
import { FilesService } from './files.service';
import { FilesController } from './files.controller';
import { PlanningModule } from '../planning/planning.module';

@Module({
    imports: [PlanningModule],

    controllers: [FilesController],

    providers: [FilesService],

    exports: [FilesService],
})
export class FilesModule {}
