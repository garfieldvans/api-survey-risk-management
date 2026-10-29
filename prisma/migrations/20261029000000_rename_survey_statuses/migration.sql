-- Ganti set nilai enum SurveyStatus sesuai alur review baru.
-- Nilai lama GRADING / DONE / CLOSED dihapus; REQUEST_REVISE / REVISED / APPROVED ditambahkan.
-- Data existing dipetakan (bukan dibuang):
--   GRADING       -> REVIEW        (grading kini proses di dalam review)
--   DONE, CLOSED  -> APPROVED
--   ONBOARD, REVIEW, REJECTED tetap.

-- 1) Lepas default & ubah kolom ke TEXT supaya tipe enum bisa dibuang/dibuat ulang.
ALTER TABLE "Survey" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Survey" ALTER COLUMN "status" TYPE TEXT USING "status"::text;

-- 2) Buang tipe enum lama (Postgres tidak punya DROP VALUE, jadi dibuat ulang).
DROP TYPE "SurveyStatus";

CREATE TYPE "SurveyStatus" AS ENUM (
  'ONBOARD',
  'REVIEW',
  'REQUEST_REVISE',
  'REVISED',
  'REJECTED',
  'APPROVED'
);

-- 3) Konversi kembali ke enum sambil memetakan nilai lama ke nilai baru.
ALTER TABLE "Survey"
  ALTER COLUMN "status" TYPE "SurveyStatus"
  USING (
    CASE "status"
      WHEN 'GRADING' THEN 'REVIEW'
      WHEN 'DONE'    THEN 'APPROVED'
      WHEN 'CLOSED'  THEN 'APPROVED'
      ELSE "status"
    END
  )::"SurveyStatus";

-- 4) Pasang ulang default.
ALTER TABLE "Survey" ALTER COLUMN "status" SET DEFAULT 'ONBOARD'::"SurveyStatus";
