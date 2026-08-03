import { IsUUID } from 'class-validator';

export class TransferOwnershipDto {

    @IsUUID()
    newOwnerId!: string;

}