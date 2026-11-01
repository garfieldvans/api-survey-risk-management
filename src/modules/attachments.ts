import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma } from '../plugins/prisma';
import { authenticate, assertSurveyAccess } from '../plugins/auth';
import { ok, AppError } from '../lib/http';
import { uploadFile, deleteObject, presignedDownloadUrl, isStorageConfigured } from '../plugins/storage';

const ATTACHMENT_KINDS = ['photo', 'document', 'video'] as const;

/** Batas ukuran file upload (5 MB) — serverless function punya limit memory & body. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Prefix wajib untuk semua object di B2: application key yang dipakai dibuat
 * dengan file name prefix `SD_`, sehingga object dengan key lain ditolak
 * (403 AccessDenied "not entitled"). Lihat .env → B2_KEY_ID.
 */
const STORAGE_KEY_PREFIX = 'SD_';

export async function attachmentRoutes(fastify: FastifyInstance) {
  /**
   * POST /surveys/:id/attachments — multipart upload ke object storage (B2).
   * Field name: "file"
   */
  fastify.post('/surveys/:id/attachments', { preHandler: [authenticate()] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const survey = await prisma.survey.findUnique({ where: { id } });
    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    assertSurveyAccess(request.user!, survey.surveyorId);
    if (!isStorageConfigured()) {
      // 503 Service Unavailable — fitur memang belum diaktifkan (env STORAGE_*
      // / B2_* kosong), bukan bug server. FE menampilkan pesan ini apa adanya.
      throw new AppError(
        'Upload lampiran belum diaktifkan. Hubungi admin untuk konfigurasi penyimpanan (Backblaze B2).',
        503,
      );
    }

    // Batas fileSize WAJIB di-set di sini: default @fastify/multipart hanya
    // 1 MB dan hasilnya file besar dipotong diam-diam lalu tetap dibalas 201
    // (kehilangan data). Dengan limit ini, file > 5 MB ditolak 413.
    const file = await request.file({
      limits: { fileSize: MAX_UPLOAD_BYTES },
      throwFileSizeLimit: true,
    });
    if (!file) throw new AppError('File tidak ditemukan', 400);

    const kindField = file.fields['kind'];
    const kindRow = Array.isArray(kindField) ? kindField[0] : kindField;
    const rawKind = (kindRow as { value?: unknown } | undefined)?.value;
    const kind = rawKind ? String(rawKind) : 'photo';
    if (!ATTACHMENT_KINDS.includes(kind as (typeof ATTACHMENT_KINDS)[number])) {
      throw new AppError(`kind harus salah satu dari: ${ATTACHMENT_KINDS.join(', ')}`, 400);
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of file.file) {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES || file.file.truncated) {
        throw new AppError(
          `Ukuran file melebihi batas ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`,
          413,
        );
      }
      chunks.push(chunk);
    }
    // Busboy memotong stream saat kena limits.fileSize; cek eksplisit karena
    // `total` bisa berhenti tepat di batas sehingga lolos pemeriksaan di atas.
    if (file.file.truncated) {
      throw new AppError(
        `Ukuran file melebihi batas ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`,
        413,
      );
    }
    const buffer = Buffer.concat(chunks);

    const ext = file.filename.split('.').pop() ?? 'bin';
    const key = `${STORAGE_KEY_PREFIX}/surveys/${id}/${nanoid(12)}.${ext}`;

    const stored = await uploadFile({
      key,
      body: buffer,
      contentType: file.mimetype,
      contentLength: buffer.length,
    });

    const attachment = await prisma.surveyAttachment.create({
      data: {
        surveyId: id,
        fileName: file.filename,
        fileKey: stored.key,
        mimeType: file.mimetype,
        sizeBytes: buffer.length,
        kind,
      },
    });

    return reply.code(201).send(ok({ attachment }));
  });

  /**
   * GET /surveys/:id/attachments — list attachments with presigned download URLs.
   */
  fastify.get('/surveys/:id/attachments', { preHandler: [authenticate()] }, async (request) => {
    const { id } = request.params as { id: string };

    const survey = await prisma.survey.findUnique({ where: { id } });
    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    assertSurveyAccess(request.user!, survey.surveyorId);

    const attachments = await prisma.surveyAttachment.findMany({
      where: { surveyId: id },
      orderBy: { createdAt: 'asc' },
    });

    // Attach presigned URLs
    const attachmentsWithUrls = await Promise.all(
      attachments.map(async (att) => {
        const url = isStorageConfigured()
          ? await presignedDownloadUrl(att.fileKey).catch(() => null)
          : null;
        return { ...att, downloadUrl: url };
      }),
    );

    return ok({ attachments: attachmentsWithUrls });
  });

  /**
   * DELETE /surveys/:id/attachments/:attachmentId — delete from object storage + DB.
   */
  fastify.delete('/surveys/:id/attachments/:attachmentId', { preHandler: [authenticate()] }, async (request) => {
    const { id, attachmentId } = request.params as { id: string; attachmentId: string };

    const attachment = await prisma.surveyAttachment.findUnique({
      where: { id: attachmentId },
      include: { survey: { select: { surveyorId: true } } },
    });
    if (!attachment || attachment.surveyId !== id) {
      throw new AppError('Attachment tidak ditemukan', 404);
    }
    assertSurveyAccess(request.user!, attachment.survey.surveyorId);

    if (isStorageConfigured()) {
      await deleteObject(attachment.fileKey).catch((e) => {
        console.warn(`Gagal hapus object storage: ${attachment.fileKey}`, e.message);
      });
    }

    await prisma.surveyAttachment.delete({ where: { id: attachmentId } });

    return ok({ message: 'Attachment dihapus' });
  });
}