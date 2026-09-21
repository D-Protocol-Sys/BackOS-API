import { Controller, Get, Patch, Delete, Param, Body, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { ClientsService } from './clients.service';
import { UpdateContractDto } from './dto/update-contract.dto';
import { PERMISSIONS } from '../common/constants/permissions.constant';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Controller managing HTTP requests for a single contract's own lifecycle - reading, updating,
 * and archiving/restoring/permanently deleting it. Contract *creation* stays on
 * `POST /clients/:id/contracts` (`ClientsController.addContract()`) since a contract only ever
 * makes sense attached to a client from the start; everything else here operates on the
 * contract's own ID directly, mirroring the permission granularity that already existed
 * (`CONTRACT_READ`/`CONTRACT_UPDATE`/`CONTRACT_DELETE`, separate from the `CLIENT_*` set) even
 * before any of these routes were wired up.
 */
@ApiTags('Contracts')
@ApiBearerAuth('access-token')
@Controller('contracts')
export class ContractsController {

    constructor(private readonly clientsService: ClientsService) {}

    /**
     * Retrieves a single contract by ID.
     */
    @Get(':id')
    @RequirePermissions(PERMISSIONS.CONTRACT_READ)
    @ApiOperation({
        summary: 'Get contract by ID',
        description: 'Fetches a single contract record.',
    })
    @ApiParam({ name: 'id', description: 'Contract unique identifier' })
    @ApiResponse({ status: 200, description: 'Contract retrieved successfully.' })
    @ApiResponse({ status: 404, description: 'Contract not found.' })
    getById(@Param('id') id: string) {
        return this.clientsService.getContract(id);
    }

    /**
     * Updates a contract's editable fields (title, description, billing, dates, status other
     * than ARCHIVED - see `UpdateContractDto`/`ClientsService.updateContract()`).
     */
    @Patch(':id')
    @RequirePermissions(PERMISSIONS.CONTRACT_UPDATE)
    @ApiOperation({
        summary: 'Update a contract',
        description: 'Updates contract fields.',
    })
    @ApiParam({ name: 'id', description: 'Contract unique identifier' })
    @ApiResponse({ status: 200, description: 'Contract updated successfully.' })
    @ApiResponse({ status: 404, description: 'Contract not found.' })
    update(
        @Param('id') id: string,
        @Body() dto: UpdateContractDto,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.updateContract(id, dto, userId, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Archives a contract (soft delete): starts a retention countdown after which it (and its
     * attached files) is permanently deleted automatically - independently of its client's own
     * archive state. Reversible via `PATCH /contracts/:id/restore`.
     */
    @Delete(':id')
    @RequirePermissions(PERMISSIONS.CONTRACT_DELETE)
    @ApiOperation({
        summary: 'Archive a contract',
        description: 'Archives a contract and starts its permanent-deletion countdown. Reversible via restore.',
    })
    @ApiParam({ name: 'id', description: 'Contract unique identifier' })
    @ApiResponse({ status: 200, description: 'Contract archived successfully.' })
    @ApiResponse({ status: 404, description: 'Contract not found.' })
    archive(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.archiveContract(id, userId, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Restores an archived contract, cancelling its pending permanent deletion.
     */
    @Patch(':id/restore')
    @RequirePermissions(PERMISSIONS.CONTRACT_DELETE)
    @ApiOperation({
        summary: 'Restore an archived contract',
        description: 'Restores an archived contract back to ACTIVE and cancels its pending deletion.',
    })
    @ApiParam({ name: 'id', description: 'Contract unique identifier' })
    @ApiResponse({ status: 200, description: 'Contract restored successfully.' })
    @ApiResponse({ status: 404, description: 'Contract not found.' })
    restore(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.restoreContract(id, userId, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });
    }

    /**
     * Immediately and irreversibly deletes an already-archived contract (and its attached
     * files), without waiting for its retention window to elapse.
     */
    @Delete(':id/permanent')
    @RequirePermissions(PERMISSIONS.CONTRACT_DELETE)
    @ApiOperation({
        summary: 'Permanently delete a contract',
        description: 'Immediately and irreversibly deletes an already-archived contract and its files.',
    })
    @ApiParam({ name: 'id', description: 'Contract unique identifier' })
    @ApiResponse({ status: 200, description: 'Contract permanently deleted.' })
    @ApiResponse({ status: 404, description: 'Contract not found.' })
    purge(
        @Param('id') id: string,
        @CurrentUser('userId') userId: string,
        @Req() req: any,
    ) {
        return this.clientsService.purgeContract(id, userId, {
            ipAddress: req.ip,
            userAgent: req.headers['user-agent'],
        });
    }
}
