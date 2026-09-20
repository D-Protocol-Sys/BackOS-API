/*
  Warnings:

  - You are about to drop the column `documentUrl` on the `client_contracts` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "ContractStatus" ADD VALUE 'ARCHIVED';

-- AlterTable
ALTER TABLE "client_contracts" DROP COLUMN "documentUrl",
ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "clients" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "file_assets" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "contractId" TEXT;

-- CreateIndex
CREATE INDEX "file_assets_projectId_idx" ON "file_assets"("projectId");

-- CreateIndex
CREATE INDEX "file_assets_contractId_idx" ON "file_assets"("contractId");

-- CreateIndex
CREATE INDEX "projects_clientId_idx" ON "projects"("clientId");

-- CreateIndex
CREATE INDEX "projects_contractId_idx" ON "projects"("contractId");

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "client_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "client_contracts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
