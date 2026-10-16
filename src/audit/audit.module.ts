import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditController } from './audit.controller';

/**
 * Global Audit Module.
 * Provides central audit logging capabilities across the entire application,
 * allowing any service to record security events, administrative mutations,
 * and compliance-related activities.
 */
@Global()
@Module({
    controllers: [AuditController],

    providers: [AuditLogService],

    exports: [AuditLogService],
})
export class AuditModule {}
