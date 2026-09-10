-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "deletedForEveryoneAt" TIMESTAMP(3),
ALTER COLUMN "content" DROP NOT NULL;

-- CreateTable
CREATE TABLE "message_hidden_for" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_hidden_for_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_hidden_for_messageId_userId_key" ON "message_hidden_for"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "message_hidden_for" ADD CONSTRAINT "message_hidden_for_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_hidden_for" ADD CONSTRAINT "message_hidden_for_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
