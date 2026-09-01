/*
  Warnings:

  - Made the column `planningId` on table `planning_entries` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "planning_entries" ALTER COLUMN "planningId" SET NOT NULL;
