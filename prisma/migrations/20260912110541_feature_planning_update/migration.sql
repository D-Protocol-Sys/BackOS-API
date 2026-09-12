/*
  Warnings:

  - A unique constraint covering the columns `[programEntryId,occurrenceDate]` on the table `planning_entries` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "PlanningWeekDay" AS ENUM ('MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY');

-- DropIndex
DROP INDEX "planning_entries_endAt_idx";

-- DropIndex
DROP INDEX "planning_entries_startAt_idx";

-- DropIndex
DROP INDEX "planning_entry_assignees_userId_idx";

-- AlterTable
ALTER TABLE "planning_entries" ADD COLUMN     "occurrenceDate" TIMESTAMP(3),
ADD COLUMN     "programEntryId" TEXT,
ADD COLUMN     "programId" TEXT;

-- CreateTable
CREATE TABLE "planning_programs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "schedule" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "anchorDate" TIMESTAMP(3),
    "cycleWeeks" INTEGER NOT NULL DEFAULT 1,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "planningId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_program_weeks" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "weekIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_program_weeks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_program_days" (
    "id" TEXT NOT NULL,
    "weekId" TEXT NOT NULL,
    "dayOfWeek" "PlanningWeekDay" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_program_days_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_program_entries" (
    "id" TEXT NOT NULL,
    "type" "PlanningItemType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startTime" TEXT,
    "endTime" TEXT,
    "dayId" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_program_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "planning_programs_createdById_idx" ON "planning_programs"("createdById");

-- CreateIndex
CREATE INDEX "planning_programs_planningId_idx" ON "planning_programs"("planningId");

-- CreateIndex
CREATE INDEX "planning_programs_active_idx" ON "planning_programs"("active");

-- CreateIndex
CREATE INDEX "planning_programs_schedule_idx" ON "planning_programs"("schedule");

-- CreateIndex
CREATE INDEX "planning_programs_startDate_idx" ON "planning_programs"("startDate");

-- CreateIndex
CREATE INDEX "planning_programs_endDate_idx" ON "planning_programs"("endDate");

-- CreateIndex
CREATE INDEX "planning_program_weeks_programId_idx" ON "planning_program_weeks"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "planning_program_weeks_programId_weekIndex_key" ON "planning_program_weeks"("programId", "weekIndex");

-- CreateIndex
CREATE INDEX "planning_program_days_weekId_idx" ON "planning_program_days"("weekId");

-- CreateIndex
CREATE UNIQUE INDEX "planning_program_days_weekId_dayOfWeek_key" ON "planning_program_days"("weekId", "dayOfWeek");

-- CreateIndex
CREATE INDEX "planning_program_entries_dayId_idx" ON "planning_program_entries"("dayId");

-- CreateIndex
CREATE INDEX "planning_program_entries_dayId_order_idx" ON "planning_program_entries"("dayId", "order");

-- CreateIndex
CREATE INDEX "planning_entries_planningId_startAt_idx" ON "planning_entries"("planningId", "startAt");

-- CreateIndex
CREATE INDEX "planning_entries_planningId_dueDate_idx" ON "planning_entries"("planningId", "dueDate");

-- CreateIndex
CREATE INDEX "planning_entries_planningId_status_idx" ON "planning_entries"("planningId", "status");

-- CreateIndex
CREATE INDEX "planning_entries_programId_idx" ON "planning_entries"("programId");

-- CreateIndex
CREATE UNIQUE INDEX "planning_entries_programEntryId_occurrenceDate_key" ON "planning_entries"("programEntryId", "occurrenceDate");

-- CreateIndex
CREATE INDEX "planning_entry_assignees_userId_entryId_idx" ON "planning_entry_assignees"("userId", "entryId");

-- AddForeignKey
ALTER TABLE "planning_programs" ADD CONSTRAINT "planning_programs_planningId_fkey" FOREIGN KEY ("planningId") REFERENCES "plannings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_programs" ADD CONSTRAINT "planning_programs_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_program_weeks" ADD CONSTRAINT "planning_program_weeks_programId_fkey" FOREIGN KEY ("programId") REFERENCES "planning_programs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_program_days" ADD CONSTRAINT "planning_program_days_weekId_fkey" FOREIGN KEY ("weekId") REFERENCES "planning_program_weeks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_program_entries" ADD CONSTRAINT "planning_program_entries_dayId_fkey" FOREIGN KEY ("dayId") REFERENCES "planning_program_days"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entries" ADD CONSTRAINT "planning_entries_programId_fkey" FOREIGN KEY ("programId") REFERENCES "planning_programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entries" ADD CONSTRAINT "planning_entries_programEntryId_fkey" FOREIGN KEY ("programEntryId") REFERENCES "planning_program_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
