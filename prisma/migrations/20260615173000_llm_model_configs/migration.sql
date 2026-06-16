CREATE TABLE "LlmModelConfig" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "displayName" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LlmModelConfig_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LlmModelConfig_clientId_updatedAt_idx" ON "LlmModelConfig"("clientId", "updatedAt");
