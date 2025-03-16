/*
  Warnings:

  - A unique constraint covering the columns `[instanceId,remoteJid]` on the table `Chat` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
        WHERE indexname = 'Chat_instanceId_remoteJid_key'
    ) THEN
        CREATE UNIQUE INDEX "Chat_instanceId_remoteJid_key" ON "Chat"("instanceId", "remoteJid");
    END IF;
END
$$;