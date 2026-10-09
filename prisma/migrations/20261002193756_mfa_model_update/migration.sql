/*
  Warnings:

  - A unique constraint covering the columns `[generatedPort]` on the table `platforms` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "user_mfa" ADD COLUMN     "lastUsedStep" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX "platforms_generatedPort_key" ON "platforms"("generatedPort");
