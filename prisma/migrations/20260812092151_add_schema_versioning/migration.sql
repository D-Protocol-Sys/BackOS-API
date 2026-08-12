-- AlterTable
ALTER TABLE "generations" ADD COLUMN     "schemaVersion" INTEGER;

-- AlterTable
ALTER TABLE "platforms" ADD COLUMN     "schemaVersion" INTEGER NOT NULL DEFAULT 0;
