import { IsUUID } from 'class-validator';

export class AddPlanningMemberDto {
    @IsUUID()
    userId!: string;
}