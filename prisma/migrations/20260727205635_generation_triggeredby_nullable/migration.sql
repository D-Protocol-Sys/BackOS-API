-- DropForeignKey
ALTER TABLE "generations" DROP CONSTRAINT "generations_triggeredById_fkey";

-- AlterTable
ALTER TABLE "generations" ALTER COLUMN "triggeredById" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
