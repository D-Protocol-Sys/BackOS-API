import { Module } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectsController } from './projects.controller';
import { FilesModule } from '../files/files.module';

@Module({

    // FilesModule gives ProjectsService access to FilesService.purgeFilesForParent(), used
    // when a project is permanently deleted - see ProjectsService.delete().
    imports: [FilesModule],

    controllers: [ProjectsController],

    providers: [ProjectsService],

    exports: [ProjectsService],

})
export class ProjectsModule {}
