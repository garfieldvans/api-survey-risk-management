-- DropForeignKey
ALTER TABLE "Property" DROP CONSTRAINT "Property_occupationId_fkey";

-- AlterTable
ALTER TABLE "Property" ALTER COLUMN "occupationId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "Property" ADD CONSTRAINT "Property_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "Occupation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
