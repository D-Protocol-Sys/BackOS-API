-- CreateEnum
CREATE TYPE "RelationType" AS ENUM ('ONE_TO_ONE', 'ONE_TO_MANY', 'MANY_TO_MANY');

-- CreateTable
CREATE TABLE "relations" (
    "id" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "type" "RelationType" NOT NULL,
    "entityAId" TEXT NOT NULL,
    "entityBId" TEXT NOT NULL,
    "fieldNameOnA" TEXT NOT NULL,
    "fieldNameOnB" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "relations_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "relations" ADD CONSTRAINT "relations_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relations" ADD CONSTRAINT "relations_entityAId_fkey" FOREIGN KEY ("entityAId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relations" ADD CONSTRAINT "relations_entityBId_fkey" FOREIGN KEY ("entityBId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
