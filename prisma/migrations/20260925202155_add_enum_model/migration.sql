-- AlterEnum
ALTER TYPE "FieldType" ADD VALUE 'ENUM';

-- AlterTable
ALTER TABLE "fields" ADD COLUMN     "enumDefinitionId" TEXT;

-- CreateTable
CREATE TABLE "enum_definitions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "values" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "platformId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "enum_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "enum_definitions_platformId_name_key" ON "enum_definitions"("platformId", "name");

-- AddForeignKey
ALTER TABLE "enum_definitions" ADD CONSTRAINT "enum_definitions_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fields" ADD CONSTRAINT "fields_enumDefinitionId_fkey" FOREIGN KEY ("enumDefinitionId") REFERENCES "enum_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
