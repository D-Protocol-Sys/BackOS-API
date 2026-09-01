/*
  Warnings:

  - You are about to drop the column `personalUserId` on the `planning_entries` table. All the data in the column will be lost.
  - You are about to drop the column `platformId` on the `planning_entries` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "PlanningScope" AS ENUM ('PERSONAL', 'PLATFORM', 'TEAM');

-- CreateEnum
CREATE TYPE "ClientType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('PROSPECT', 'ONBOARDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'PENDING_SIGNATURE', 'ACTIVE', 'EXPIRED', 'TERMINATED', 'CANCELED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PlanningItemType" ADD VALUE 'SHIFT';
ALTER TYPE "PlanningItemType" ADD VALUE 'LEAVE';
ALTER TYPE "PlanningItemType" ADD VALUE 'ON_CALL';
ALTER TYPE "PlanningItemType" ADD VALUE 'MEETING';
ALTER TYPE "PlanningItemType" ADD VALUE 'HOLIDAY';

-- DropForeignKey
ALTER TABLE "planning_entries" DROP CONSTRAINT "planning_entries_personalUserId_fkey";

-- DropForeignKey
ALTER TABLE "planning_entries" DROP CONSTRAINT "planning_entries_platformId_fkey";

-- DropIndex
DROP INDEX "planning_entries_personalUserId_idx";

-- DropIndex
DROP INDEX "planning_entries_platformId_idx";

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "replyToId" TEXT;

-- AlterTable
ALTER TABLE "planning_entries" DROP COLUMN "personalUserId",
DROP COLUMN "platformId",
ADD COLUMN     "planningId" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "plannings" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "PlanningScope" NOT NULL,
    "description" TEXT,
    "responsibleId" TEXT,
    "platformId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Paris',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plannings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "planning_members" (
    "id" TEXT NOT NULL,
    "planningId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "planning_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "type" "ClientType" NOT NULL DEFAULT 'COMPANY',
    "companyName" TEXT,
    "vatNumber" TEXT,
    "registrationNumber" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "streetAddress" TEXT,
    "city" TEXT,
    "postalCode" TEXT,
    "country" TEXT DEFAULT 'FR',
    "status" "ClientStatus" NOT NULL DEFAULT 'PROSPECT',
    "notes" TEXT,
    "testimonialText" TEXT,
    "testimonialRating" INTEGER,
    "testimonialGivenAt" TIMESTAMP(3),
    "isTestimonialPublic" BOOLEAN NOT NULL DEFAULT false,
    "testimonialToken" TEXT,
    "testimonialTokenExpiresAt" TIMESTAMP(3),
    "platformId" TEXT,
    "customServiceScope" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_contracts" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "contractNumber" TEXT NOT NULL,
    "billingAmount" DOUBLE PRECISION,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "serviceKey" TEXT,
    "signedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "documentUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_contracts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "plannings_platformId_key" ON "plannings"("platformId");

-- CreateIndex
CREATE INDEX "plannings_responsibleId_idx" ON "plannings"("responsibleId");

-- CreateIndex
CREATE INDEX "plannings_scope_idx" ON "plannings"("scope");

-- CreateIndex
CREATE INDEX "planning_members_userId_idx" ON "planning_members"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "planning_members_planningId_userId_key" ON "planning_members"("planningId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "clients_email_key" ON "clients"("email");

-- CreateIndex
CREATE UNIQUE INDEX "clients_testimonialToken_key" ON "clients"("testimonialToken");

-- CreateIndex
CREATE INDEX "clients_platformId_idx" ON "clients"("platformId");

-- CreateIndex
CREATE INDEX "clients_status_idx" ON "clients"("status");

-- CreateIndex
CREATE INDEX "clients_email_idx" ON "clients"("email");

-- CreateIndex
CREATE INDEX "clients_isTestimonialPublic_idx" ON "clients"("isTestimonialPublic");

-- CreateIndex
CREATE UNIQUE INDEX "client_contracts_contractNumber_key" ON "client_contracts"("contractNumber");

-- CreateIndex
CREATE INDEX "client_contracts_clientId_idx" ON "client_contracts"("clientId");

-- CreateIndex
CREATE INDEX "client_contracts_status_idx" ON "client_contracts"("status");

-- CreateIndex
CREATE INDEX "planning_entries_planningId_idx" ON "planning_entries"("planningId");

-- CreateIndex
CREATE INDEX "planning_entries_creatorId_idx" ON "planning_entries"("creatorId");

-- CreateIndex
CREATE INDEX "planning_entries_startAt_idx" ON "planning_entries"("startAt");

-- CreateIndex
CREATE INDEX "planning_entries_endAt_idx" ON "planning_entries"("endAt");

-- CreateIndex
CREATE INDEX "planning_entry_assignees_userId_idx" ON "planning_entry_assignees"("userId");

-- AddForeignKey
ALTER TABLE "plannings" ADD CONSTRAINT "plannings_responsibleId_fkey" FOREIGN KEY ("responsibleId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "plannings" ADD CONSTRAINT "plannings_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_members" ADD CONSTRAINT "planning_members_planningId_fkey" FOREIGN KEY ("planningId") REFERENCES "plannings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_members" ADD CONSTRAINT "planning_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "planning_entries" ADD CONSTRAINT "planning_entries_planningId_fkey" FOREIGN KEY ("planningId") REFERENCES "plannings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_contracts" ADD CONSTRAINT "client_contracts_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
