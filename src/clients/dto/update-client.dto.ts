import { PartialType } from '@nestjs/mapped-types';
import { CreateClientDto } from './create-client.dto';

/**
 * Data Transfer Object (DTO) for client updates.
 * Extends CreateClientDto using PartialType, making all inherited properties
 * optional automatically so that updates can be partial (PATCH requests).
 */
export class UpdateClientDto extends PartialType(CreateClientDto) {}
