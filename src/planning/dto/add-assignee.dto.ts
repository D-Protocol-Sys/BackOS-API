import { IsUUID } from 'class-validator';

export class AddAssigneeDto {
    @IsUUID()
    userId!: string;
}