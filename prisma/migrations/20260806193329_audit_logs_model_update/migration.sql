/*
  Warnings:

  - You are about to drop the column `userId` on the `audit_logs` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_userId_fkey";

-- DropIndex
DROP INDEX "audit_logs_userId_idx";

-- AlterTable
ALTER TABLE "audit_logs" DROP COLUMN "userId",
ADD COLUMN     "actorId" TEXT;

-- CreateIndex
CREATE INDEX "audit_logs_actorId_idx" ON "audit_logs"("actorId");

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
