/*
  Warnings:

  - You are about to drop the column `role` on the `platform_members` table. All the data in the column will be lost.
  - Added the required column `platformRoleId` to the `platform_members` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "GenerationStatus" ADD VALUE 'AWAITING_APPROVAL';

-- AlterTable
ALTER TABLE "generations" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT;

-- AlterTable
ALTER TABLE "platform_members" DROP COLUMN "role",
ADD COLUMN     "platformRoleId" TEXT NOT NULL;

-- DropEnum
DROP TYPE "PlatformRole";

-- CreateTable
CREATE TABLE "platform_roles" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "platformId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_permissions" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "platform_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_role_permissions" (
    "id" TEXT NOT NULL,
    "platformRoleId" TEXT NOT NULL,
    "platformPermissionId" TEXT NOT NULL,

    CONSTRAINT "platform_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "platform_roles_platformId_idx" ON "platform_roles"("platformId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_roles_platformId_name_key" ON "platform_roles"("platformId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "platform_permissions_key_key" ON "platform_permissions"("key");

-- CreateIndex
CREATE UNIQUE INDEX "platform_role_permissions_platformRoleId_platformPermission_key" ON "platform_role_permissions"("platformRoleId", "platformPermissionId");

-- CreateIndex
CREATE INDEX "generations_status_idx" ON "generations"("status");

-- CreateIndex
CREATE INDEX "platform_members_platformRoleId_idx" ON "platform_members"("platformRoleId");

-- AddForeignKey
ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_platformRoleId_fkey" FOREIGN KEY ("platformRoleId") REFERENCES "platform_roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_roles" ADD CONSTRAINT "platform_roles_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_platformRoleId_fkey" FOREIGN KEY ("platformRoleId") REFERENCES "platform_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_role_permissions" ADD CONSTRAINT "platform_role_permissions_platformPermissionId_fkey" FOREIGN KEY ("platformPermissionId") REFERENCES "platform_permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generations" ADD CONSTRAINT "generations_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
