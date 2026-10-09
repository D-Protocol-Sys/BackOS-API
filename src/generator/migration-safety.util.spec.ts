import { findDestructiveStatements } from './migration-safety.util';

describe('findDestructiveStatements (audit GEN-001)', () => {
    it('ne signale rien pour une migration purement additive', () => {
        const sql = `
            -- CreateTable
            CREATE TABLE "Project" ("id" TEXT NOT NULL, CONSTRAINT "Project_pkey" PRIMARY KEY ("id"));
            ALTER TABLE "Project" ADD COLUMN "title" TEXT;
            CREATE INDEX "Project_title_idx" ON "Project"("title");
        `;
        expect(findDestructiveStatements(sql)).toEqual([]);
    });

    it.each([
        ['DROP TABLE "Project";'],
        ['ALTER TABLE "Project" DROP COLUMN "title";'],
        ['DROP TYPE "Status";'],
        ['TRUNCATE "Project";'],
        ['DELETE FROM "Project";'],
        ['ALTER TABLE "Project" ALTER COLUMN "price" SET DATA TYPE INTEGER;'],
        ['ALTER TABLE "Project" ALTER COLUMN "title" SET NOT NULL;'],
        ['ALTER TABLE "Project" RENAME COLUMN "a" TO "b";'],
    ])('signale %s', (statement) => {
        expect(findDestructiveStatements(statement)).toHaveLength(1);
    });

    it('ignore les commentaires SQL', () => {
        expect(findDestructiveStatements('-- DROP TABLE "Project";\nCREATE TABLE "A" ("id" TEXT);')).toEqual([]);
    });
});
