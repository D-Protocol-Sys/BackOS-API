-- CreateEnum
CREATE TYPE "StatusChangeReason" AS ENUM ('ONBOARDING', 'VOLUNTARY_LEAVE', 'TERMINATION', 'LONG_LEAVE', 'SECURITY_SUSPENSION', 'PERIODIC_CLEANUP', 'OTHER');

-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "targetId" TEXT,
ADD COLUMN     "targetType" TEXT;

-- AlterTable
ALTER TABLE "user_profiles" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "lastSeenAt" TIMESTAMP(3),
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_status_history" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "previousStatus" "UserStatus",
    "newStatus" "UserStatus" NOT NULL,
    "reason" "StatusChangeReason" NOT NULL,
    "comment" TEXT,
    "performedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_status_history_userId_idx" ON "user_status_history"("userId");

-- CreateIndex
CREATE INDEX "user_status_history_performedById_idx" ON "user_status_history"("performedById");

-- CreateIndex
CREATE INDEX "audit_logs_targetType_targetId_idx" ON "audit_logs"("targetType", "targetId");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_username_idx" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_workEmail_idx" ON "users"("workEmail");

-- AddForeignKey
ALTER TABLE "user_status_history" ADD CONSTRAINT "user_status_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_status_history" ADD CONSTRAINT "user_status_history_performedById_fkey" FOREIGN KEY ("performedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
