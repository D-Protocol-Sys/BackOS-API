-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('VIEWER', 'EDITOR', 'MANAGER');

-- CreateTable
CREATE TABLE "platform_members" (
    "id" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_members_platformId_userId_key" ON "platform_members"("platformId", "userId");

-- AddForeignKey
ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_members" ADD CONSTRAINT "platform_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
