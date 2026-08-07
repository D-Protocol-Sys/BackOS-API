import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../common/constants/permissions.constant';

/**
 * Controller providing administrative endpoints for accessing system audit logs and security trails.
 */
@ApiTags('Audit Logs')
@ApiBearerAuth('access-token')
@Controller('audit-logs')
export class AuditController {

    constructor(
        private readonly auditLogService: AuditLogService,
    ) {}

    /**
     * Retrieves a paginated/limited list of system audit logs.
     * Accessible only by users holding the `AUDIT_READ` permission.
     * * @param query - Query parameters containing search, filter, and pagination limits.
     * @returns List of audit log records with associated user details.
     */
    @Get()
    @RequirePermissions(PERMISSIONS.AUDIT_READ)
    @ApiOperation({ summary: 'Retrieve recent system audit log records' })
    @ApiOkResponse({
        description: 'Successfully retrieved audit log records.',
    })
    list(
        @Query() query: AuditLogQueryDto,
    ) {
        return this.auditLogService.list(query.limit);
    }
}