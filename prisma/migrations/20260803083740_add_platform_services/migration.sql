-- CreateTable
CREATE TABLE "platform_services" (
    "id" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "serviceKey" TEXT NOT NULL,
    "config" JSONB,
    "encryptedConfig" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "platform_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platform_services_platformId_serviceKey_key" ON "platform_services"("platformId", "serviceKey");

-- AddForeignKey
ALTER TABLE "platform_services" ADD CONSTRAINT "platform_services_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "platforms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
