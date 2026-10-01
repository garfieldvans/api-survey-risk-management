import { prisma } from '../plugins/prisma';

export async function notifyAdmins(surveyId: string, message: string): Promise<void> {
  const admins = await prisma.user.findMany({
    where: { role: 'ADMIN' },
    select: { id: true },
  });

  if (admins.length === 0) return;

  await prisma.notification.createMany({
    data: admins.map((a) => ({
      userId: a.id,
      surveyId,
      message,
    })),
  });
}

export async function notifyAdminsForStatusChange(
  surveyId: string,
  propertyName: string,
  newStatus: string,
): Promise<void> {
  await notifyAdmins(surveyId, `Survei "${propertyName}" pindah ke status ${newStatus}`);
}