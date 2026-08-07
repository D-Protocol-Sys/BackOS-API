/*
  Warnings:

  - You are about to drop the column `personalEmail` on the `user_profiles` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[personalEmail]` on the table `users` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "user_profiles" DROP COLUMN "personalEmail";

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "personalEmail" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_personalEmail_key" ON "users"("personalEmail");
