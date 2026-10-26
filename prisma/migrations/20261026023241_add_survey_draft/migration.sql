-- CreateTable
CREATE TABLE "SurveyDraft" (
    "id" TEXT NOT NULL,
    "surveyorId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurveyDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SurveyDraft_surveyorId_expiresAt_idx" ON "SurveyDraft"("surveyorId", "expiresAt");

-- AddForeignKey
ALTER TABLE "SurveyDraft" ADD CONSTRAINT "SurveyDraft_surveyorId_fkey" FOREIGN KEY ("surveyorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
