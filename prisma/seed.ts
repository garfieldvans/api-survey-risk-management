import { PrismaClient, Role, AnswerType } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { SURVEY_ITEMS } from '../src/shared/index.js';
import { importOjk } from './import-ojk';
import { OJK_DATA } from './ojk-data';

const prisma = new PrismaClient();

// Sample dynamic questionnaire. Core = all surveys (occupationId null).
// Occupation-linked questions branch by the occupation tree: an occupation
// loads core + ancestor-path questions (L1 → L2 → L3). Codes must exist in the
// OJK master data (see ojk-data.ts / pnpm db:import-ojk).
type SeedQuestion = {
  text: string;
  answerType: AnswerType;
  section: string;
  order: number;
  required?: boolean;
  occupationCode?: string; // code matches OJK data; omit for core
};

const QUESTION_SEED: SeedQuestion[] = [
  // -- Core: Data Umum --
  { text: 'Nama usaha / badan di lokasi', answerType: 'TEXT', section: 'Data Umum', order: 1, required: true },
  { text: 'Nama penanggung jawab / kontak', answerType: 'TEXT', section: 'Data Umum', order: 2, required: true },
  { text: 'Nomor telepon / HP', answerType: 'TEXT', section: 'Data Umum', order: 3 },
  { text: 'Jumlah karyawan', answerType: 'NUMBER', section: 'Data Umum', order: 4, required: true },
  { text: 'Berapa lama usaha beroperasi (tahun)?', answerType: 'NUMBER', section: 'Data Umum', order: 5 },
  // -- Core: Data Properti --
  { text: 'Luas bangunan (m²)', answerType: 'NUMBER', section: 'Data Properti', order: 1, required: true },
  { text: 'Luas tanah (m²)', answerType: 'NUMBER', section: 'Data Properti', order: 2 },
  { text: 'Jumlah lantai bangunan', answerType: 'NUMBER', section: 'Data Properti', order: 3, required: true },
  { text: 'Struktur utama bangunan', answerType: 'TEXT', section: 'Data Properti', order: 4 },
  { text: 'Usia bangunan (tahun)', answerType: 'NUMBER', section: 'Data Properti', order: 5 },
  { text: 'Adakah sistem proteksi kebakaran?', answerType: 'YES_NO', section: 'Data Properti', order: 6 },
  // -- L1 21: Stone, gravel and sand extraction installations --
  { text: 'Apakah aktivitas berlangsung di area terbuka?', answerType: 'YES_NO', section: 'Operasional L1', order: 1, occupationCode: '21' },
  { text: 'Metode penambangan / penggalian utama', answerType: 'TEXT', section: 'Operasional L1', order: 2, occupationCode: '21' },
  { text: 'Volume produksi harian (ton)', answerType: 'NUMBER', section: 'Operasional L1', order: 3, occupationCode: '21' },
  { text: 'Berdampingan dengan pemukiman?', answerType: 'YES_NO', section: 'Operasional L1', order: 4, occupationCode: '21' },
  // -- L2 211: Cement, Chalk, Lime and Gypsum Industry --
  { text: 'Jumlah mesin / unit produksi di lokasi', answerType: 'NUMBER', section: 'Operasional L2', order: 1, occupationCode: '211' },
  { text: 'Apakah ada penyimpanan bahan baku dalam volume besar?', answerType: 'YES_NO', section: 'Operasional L2', order: 2, occupationCode: '211' },
  { text: 'Apakah proses produksi menggunakan panas / api (kiln)?', answerType: 'YES_NO', section: 'Operasional L2', order: 3, occupationCode: '211' },
  // -- L3 21121: Cement Factories with rotary kiln --
  { text: 'Jumlah rotary kiln di pabrik', answerType: 'NUMBER', section: 'Detail Semen Rotary Kiln', order: 1, occupationCode: '21121' },
  { text: 'Apakah bahan bakar kiln mudah terbakar (batu bara / gas)?', answerType: 'YES_NO', section: 'Detail Semen Rotary Kiln', order: 2, occupationCode: '21121' },
  { text: 'Lokasi penyimpanan klinker / semen jadi', answerType: 'TEXT', section: 'Detail Semen Rotary Kiln', order: 3, occupationCode: '21121' },
  { text: 'Apakah ada genset cadangan?', answerType: 'YES_NO', section: 'Detail Semen Rotary Kiln', order: 4, occupationCode: '21121' },
  // -- L3 21122: Cement Factories without rotary kiln --
  { text: 'Metode penggilingan klinker', answerType: 'TEXT', section: 'Detail Semen Non-Rotary', order: 1, occupationCode: '21122' },
  { text: 'Apakah ada fasilitas pengeringan bahan?', answerType: 'YES_NO', section: 'Detail Semen Non-Rotary', order: 2, occupationCode: '21122' },
  { text: 'Adakah tumpukan debu / material sisa dalam volume besar?', answerType: 'YES_NO', section: 'Detail Semen Non-Rotary', order: 3, occupationCode: '21122' },
];

async function main() {
  // Survey items (idempotent)
  for (const item of SURVEY_ITEMS) {
    await prisma.surveyItem.upsert({
      where: { code: item.code },
      update: { name: item.name, order: item.order },
      create: { code: item.code, name: item.name, order: item.order },
    });
  }

  // Users
  const adminPassword = await bcrypt.hash('admin123', 10);
  const surveyorPassword = await bcrypt.hash('surveyor123', 10);

  const admin = await prisma.user.upsert({
    where: { email: 'admin@survey.local' },
    update: {},
    create: {
      email: 'admin@survey.local',
      passwordHash: adminPassword,
      name: 'Admin Utama',
      role: Role.ADMIN,
    },
  });

  const surveyor = await prisma.user.upsert({
    where: { email: 'surveyor@survey.local' },
    update: {},
    create: {
      email: 'surveyor@survey.local',
      passwordHash: surveyorPassword,
      name: 'Surveyor Satu',
      role: Role.SURVEYOR,
    },
  });

  // Occupations — full OJK master list. Idempotent; overwrites name/parentId from
  // the OJK standard on every run so seeding stays consistent with the PDF.
  const { created, updated } = await importOjk(prisma);

  // Questions — skip reseeding if any survey answers exist (avoids FK conflicts)
  const answerCount = await prisma.surveyAnswer.count();
  let questionsSeeded = 0;
  if (answerCount === 0) {
    await prisma.question.deleteMany();
    for (const q of QUESTION_SEED) {
      const occupation = q.occupationCode
        ? await prisma.occupation.findUnique({
            where: {
              code_level: {
                code: q.occupationCode,
                level: OJK_DATA.find((n) => n.code === q.occupationCode)?.level ?? 1,
              },
            },
          })
        : null;

      await prisma.question.create({
        data: {
          text: q.text,
          answerType: q.answerType,
          section: q.section,
          order: q.order,
          required: q.required ?? false,
          occupationId: occupation?.id ?? null,
        },
      });
      questionsSeeded++;
    }
  }

  console.log('Seed selesai:');
  console.log(`  - Admin:     ${admin.email} / admin123`);
  console.log(`  - Surveyor:  ${surveyor.email} / surveyor123`);
  console.log(`  - Survey items: ${SURVEY_ITEMS.length}`);
  console.log(`  - Occupations:  ${created} dibuat, ${updated} diperbarui (standar OJK)`);
  console.log(
    answerCount > 0
      ? `  - Questions: skipped (${answerCount} jawaban sudah ada di DB)`
      : `  - Questions:  ${questionsSeeded}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());