-- CreateEnum
CREATE TYPE "RuntimeStatus" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'CRASHED');

-- AlterTable
ALTER TABLE "platforms" ADD COLUMN     "runtimePid" INTEGER,
ADD COLUMN     "runtimeStartedAt" TIMESTAMP(3),
ADD COLUMN     "runtimeStatus" "RuntimeStatus" NOT NULL DEFAULT 'STOPPED';
