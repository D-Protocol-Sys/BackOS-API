import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PermissionsService {

    constructor(private readonly prisma: PrismaService) {}

    async listAll() {
        return this.prisma.permission.findMany({ orderBy: { key: 'asc' } });
    }
    
}