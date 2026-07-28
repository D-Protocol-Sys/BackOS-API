import { Global, Module } from '@nestjs/common';
import { RoleHierarchyService } from './services/role-hierarchy.service';

@Global()
@Module({

    providers: [RoleHierarchyService],

    exports: [RoleHierarchyService],

})

export class CommonModule {}
