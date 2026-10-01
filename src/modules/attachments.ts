import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { prisma } from '../plugins/prisma';
import { authenticate, assertSurveyAccess } from '../plugins/auth';
import { ok, AppError } from '../lib/http';
import { uploadFile, deleteObject, presignedDownloadUrl, isStorageConfigured } from '../plugins/storage';

const ATTACHMENT_KINDS = ['photo', 'document', 'video'] as const;

/** Batas ukuran file upload (10 MB) — serverless function punya limit memory & body. */
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export async function attachmentRoutes(fastify: FastifyInstance) {
  /**
   * POST /surveys/:id/attachments — multipart upload to R2.
   * Field name: "file"
   */
  fastify.post('/surveys/:id/attachments', { preHandler: [authenticate()] }, async (request, reply) => {
    const { id } = request.params as { id: string };

    const survey = await prisma.survey.findUnique({ where: { id } });
    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    assertSurveyAccess(request.user!, survey.surveyorId);
    if (!isStorageConfigured()) {
      // 503 Service Unavailable — fitur memang belum diaktifkan (env R2 kosong),
      // bukan bug server. FE menampilkan pesan ini apa adanya.
      throw new AppError(
        'Upload lampiran belum diaktifkan. Hubungi admin untuk konfigurasi Cloudflare R2.',
        503,
      );
    }

    const file = await request.file();
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
      if (total > MAX_UPLOAD_BYTES) {
        throw new AppError(
          `Ukuran file melebihi batas ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`,
          413,
        );
      }
      chunks.push(chunk);
    }
    const buffer = Buffer.concat(chunks);

    const ext = file.filename.split('.').pop() ?? 'bin';
    const key = `surveys/${id}/${nanoid(12)}.${ext}`;

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
   * DELETE /surveys/:id/attachments/:attachmentId — delete from R2 + DB.
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
        console.warn(`Gagal hapus R2 object: ${attachment.fileKey}`, e.message);
      });
    }

    await prisma.surveyAttachment.delete({ where: { id: attachmentId } });

    return ok({ message: 'Attachment dihapus' });
  });
}