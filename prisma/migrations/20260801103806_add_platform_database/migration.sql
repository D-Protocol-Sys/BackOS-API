/*
  Warnings:

  - The values [MANAGER] on the enum `PlatformRole` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "PlatformRole_new" AS ENUM ('VIEWER', 'EDITOR', 'ADMIN');
ALTER TABLE "platform_members" ALTER COLUMN "role" TYPE "PlatformRole_new" USING ("role"::text::"PlatformRole_new");
ALTER TYPE "PlatformRole" RENAME TO "PlatformRole_old";
ALTER TYPE "PlatformRole_new" RENAME TO "PlatformRole";
DROP TYPE "public"."PlatformRole_old";
COMMIT;

-- AlterTable
ALTER TABLE "entities" ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "fields" ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "required" SET DEFAULT false,
ALTER COLUMN "unique" SET DEFAULT false;

-- AlterTable
ALTER TABLE "platform_members" ADD COLUMN     "removalRequestedAt" TIMESTAMP(3),
ADD COLUMN     "removalRequestedById" TEXT;

-- CreateTable
CREATE TABLE "platform_databases" (
    "id" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "databaseName" TEXT NOT NULL,
    "databaseUser" TEXT NOT NULL,
    "encryptedPassword" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_databases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_databases_platformId_key" ON "platform_databases"("platformId");

-- CreateIndex
CREATE INDEX "entities_platformId_isArchived_idx" ON "entities"("platformId", "isArchived");

-- CreateIndex
CREATE INDEX "fields_entityId_isArchived_idx" ON "fields"("entityId", "isArchived");

-- CreateIndex
CREATE INDEX "otp_codes_createdAt_idx" ON "otp_codes"("createdAt");

-- CreateIndex
CREATE INDEX "platform_members_userId_idx" ON "platform_members"("userId");

-- CreateIndex
CREATE INDEX "platforms_ownerId_idx" ON "platforms"("ownerId");

-- CreateIndex
CREATE INDEX "platforms_status_idx" ON "platforms"("status");

-- CreateIndex
CREATE INDEX "refresh_tokens_expiresAt_idx" ON "refresh_tokens"("expiresAt");

-- CreateIndex
CREATE INDEX "refresh_tokens_revokedAt_idx" ON "refresh_tokens"("revokedAt");

-- AddForeignKey
ALTER TABLE "platform_databases" ADD CONSTRAINT "platform_databases_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_removalRequestedById_fkey" FOREIGN KEY ("removalRequestedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
