import { Module } from '@nestjs/common';
import { ClientsService } from './clients.service';
import { ClientsController } from './clients.controller';
import { ContractsController } from './contracts.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { FilesModule } from '../files/files.module';

@Module({
    // FilesModule gives ClientsService access to FilesService.purgeFilesForParent(), used when
    // a contract (or a client, cascading through its contracts) is permanently deleted - see
    // ClientsService.purgeContractInternal().
    imports: [PrismaModule, AuditModule, FilesModule],
    controllers: [ClientsController, ContractsController],
    providers: [ClientsService],
    exports: [ClientsService],
})
export class ClientsModule {}
