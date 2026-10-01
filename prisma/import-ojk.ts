/**
 * Import daftar okupasi standar OJK (Lampiran I SEOJK 6/SEOJK.05/2017) ke database.
 * Sumber: apps/api/data/Daftar-Okupasi-Asuransi-PAR-26012017.pdf
 * (diekstrak terlebih dahulu menjadi prisma/ojk-data.ts).
 *
 * Idempotent: upsert per (code, level). Aman dijalankan berulang, termasuk via db:seed.
 * Jalankan manual: pnpm db:import-ojk
 */
import { pathToFileURL } from 'node:url';
import type { PrismaClient } from '@prisma/client';
import { prisma } from '../src/plugins/prisma';
import { OJK_DATA } from './ojk-data';

export async function importOjk(client: PrismaClient): Promise<{ created: number; updated: number }> {
  const byCode = new Map<string, { id: string }>();

  let created = 0;
  let updated = 0;

  // OJK_DATA sudah terurut berdasarkan level menaik → parent selalu sudah ada.
  for (const node of OJK_DATA) {
    let parentId: string | null = null;
    if (node.parentCode) {
      const parent = byCode.get(node.parentCode);
      if (!parent) {
        console.warn(`Parent ${node.parentCode} tidak ditemukan untuk ${node.code} — lewati`);
        continue;
      }
      parentId = parent.id;
    }

    const existing = await client.occupation.findUnique({
      where: { code_level: { code: node.code, level: node.level } },
    });

    if (existing) {
      const occ = await client.occupation.update({
        where: { id: existing.id },
        data: { name: node.name, parentId },
      });
      updated++;
      byCode.set(node.code, { id: occ.id });
    } else {
      const occ = await client.occupation.create({
        data: { code: node.code, name: node.name, level: node.level, parentId },
      });
      created++;
      byCode.set(node.code, { id: occ.id });
    }
  }

  return { created, updated };
}

async function main() {
  const { created, updated } = await importOjk(prisma);
  console.log(`Okupasi OJK selesai: ${created} dibuat, ${updated} diperbarui. Total ${OJK_DATA.length} node.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}