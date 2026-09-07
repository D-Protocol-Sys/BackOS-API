-- DropForeignKey
ALTER TABLE "plannings" DROP CONSTRAINT "plannings_responsibleId_fkey";

-- DropForeignKey
ALTER TABLE "user_status_history" DROP CONSTRAINT "user_status_history_userId_fkey";

-- AlterTable
ALTER TABLE "user_status_history" ALTER COLUMN "userId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "user_status_history" ADD CONSTRAINT "user_status_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plannings" ADD CONSTRAINT "plannings_responsibleId_fkey" FOREIGN KEY ("responsibleId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
