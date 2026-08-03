-- AlterTable
ALTER TABLE "entities" ADD COLUMN     "authProtectCreate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "authProtectDelete" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "authProtectRead" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "authProtectUpdate" BOOLEAN NOT NULL DEFAULT false;
