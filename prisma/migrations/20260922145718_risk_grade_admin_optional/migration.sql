-- DropForeignKey
ALTER TABLE "RiskGrade" DROP CONSTRAINT "RiskGrade_adminId_fkey";

-- AlterTable
ALTER TABLE "RiskGrade" ALTER COLUMN "adminId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "RiskGrade" ADD CONSTRAINT "RiskGrade_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
