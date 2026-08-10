-- CreateEnum
CREATE TYPE "FileCategory" AS ENUM ('DOCUMENT', 'SPREADSHEET', 'PRESENTATION', 'IMAGE', 'ARCHIVE');

-- CreateEnum
CREATE TYPE "PlanningItemType" AS ENUM ('EVENT', 'TASK', 'NOTE', 'MILESTONE');

-- CreateEnum
CREATE TYPE "PlanningItemStatus" AS ENUM ('TODO', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "file_assets" (
    "id" TEXT NOT NULL,
    "uploaderId" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "storedName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "extension" TEXT NOT NULL,
    "category" "FileCategory" NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "planningEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_entries" (
    "id" TEXT NOT NULL,
    "type" "PlanningItemType" NOT NULL,
    "personalUserId" TEXT,
    "platformId" TEXT,
    "creatorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "targetDate" TIMESTAMP(3),
    "status" "PlanningItemStatus",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_entry_assignees" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planning_entry_assignees_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "file_assets_storedName_key" ON "file_assets"("storedName");

-- CreateIndex
CREATE INDEX "file_assets_uploaderId_idx" ON "file_assets"("uploaderId");

-- CreateIndex
CREATE INDEX "file_assets_planningEntryId_idx" ON "file_assets"("planningEntryId");

-- CreateIndex
CREATE INDEX "planning_entries_personalUserId_idx" ON "planning_entries"("personalUserId");

-- CreateIndex
CREATE INDEX "planning_entries_platformId_idx" ON "planning_entries"("platformId");

-- CreateIndex
CREATE UNIQUE INDEX "planning_entry_assignees_entryId_userId_key" ON "planning_entry_assignees"("entryId", "userId");

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_assets" ADD CONSTRAINT "file_assets_planningEntryId_fkey" FOREIGN KEY ("planningEntryId") REFERENCES "planning_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entries" ADD CONSTRAINT "planning_entries_personalUserId_fkey" FOREIGN KEY ("personalUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entries" ADD CONSTRAINT "planning_entries_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entries" ADD CONSTRAINT "planning_entries_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entry_assignees" ADD CONSTRAINT "planning_entry_assignees_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "planning_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entry_assignees" ADD CONSTRAINT "planning_entry_assignees_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
