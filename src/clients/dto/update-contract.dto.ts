import { PartialType, OmitType } from '@nestjs/mapped-types';
import { CreateContractDto } from './create-contract.dto';

/**
 * Data Transfer Object (DTO) for partially updating an existing contract (PATCH).
 * All fields optional. `contractNumber` is intentionally excluded - it's the contract's
 * external/legal reference number, not meant to be silently rewritten after creation; if it
 * genuinely needs correcting, that should go through a deliberate, audited path rather than a
 * routine field update.
 */
export class UpdateContractDto extends PartialType(OmitType(CreateContractDto, ['contractNumber'] as const)) {}
