// import { PrismaService } from '../../src/prisma/prisma.service';

// export async function resetDatabase(prisma: PrismaService): Promise<void> {
//     const tables = await prisma.$queryRaw<{ tablename: string }[]>`
//         SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
//     `;

//     if (tables.length === 0) return;

//     const tableNames = tables.map((t) => `"${t.tablename}"`).join(', ');
//     await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${tableNames} RESTART IDENTITY CASCADE`);
// }