/**
 * E2E test production — mensimulasikan alur FE:
 *   login → pilih okupasi daun → wizard questions → POST /surveys (+grading)
 *   → alur status oleh admin → grade override → report → stats → notifications
 *   → cleanup, plus beberapa negative test.
 *
 * Pakai: node scripts/e2e-test.mjs
 * Env:   E2E_BASE (default production URL), E2E_EMAIL, E2E_PASSWORD (surveyor),
 *        E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD
 */
const BASE = process.env.E2E_BASE ?? 'https://api-survey-risk-management.vercel.app';
const SURVEYOR = {
  email: process.env.E2E_EMAIL ?? 'surveyor@survey.local',
  password: process.env.E2E_PASSWORD ?? 'surveyor123',
};
const ADMIN = {
  email: process.env.E2E_ADMIN_EMAIL ?? 'admin@survey.local',
  password: process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
};

const results = [];
function record(name, pass, info = '') {
  results.push({ name, pass, info });
  console.log(`${pass ? '✅' : '❌'} ${name}${info ? ` — ${info}` : ''}`);
}

function client() {
  let cookie = '';
  return async function req(method, path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    return { status: res.status, json, text };
  };
}

async function login(creds) {
  const api = client();
  const r = await api('POST', '/api/auth/login', creds);
  if (r.status !== 200) throw new Error(`login ${creds.email} gagal: ${r.status} ${r.text.slice(0, 200)}`);
  return api;
}

// ---------- helper: pilih okupasi DAUN (tidak jadi parentId siapa pun) ----------
function pickLeaf(occupations) {
  const parentIds = new Set(occupations.filter((o) => o.parentId).map((o) => o.parentId));
  const leaves = occupations.filter((o) => !parentIds.has(o.id));
  // pilih yang terdalam (level tertinggi) biar realistis kayak wizard FE
  leaves.sort((a, b) => (b.level ?? 0) - (a.level ?? 0));
  return leaves[0];
}

// ---------- helper: susun jawaban valid dari skema pertanyaan ----------
function buildAnswers(questions) {
  const answers = [];
  for (const q of questions) {
    let value = 'isi test';
    if (q.answerType === 'NUMBER') value = '1500';
    else if (q.answerType === 'YES_NO') value = 'ya';
    else if (q.answerType === 'CHOICE') value = q.options?.[0] ?? '';
    else if (q.answerType === 'MULTI') value = q.options?.[0] ?? '';
    answers.push({ questionId: q.id, value });
  }
  return answers;
}

const GRADING_INPUTS = {
  mChecklist: ['m1', 'm2'],
  mKlaim: '0',
  mImprovement: 'no',
  mRekomendasi: 'no',
  cKelas: '8',
  cSandwich: 'no',
  cAcp: 'no',
  oHazard: '8',
  pApar: 'good',
  pHidran: 'none',
  pDetektor: 'none',
  pSprinkler: 'none',
  pDamkar: '8',
  exKondisi: '4',
  nhGempa: 'avg',
  nhTsunami: 'avg',
  nhPetir: 'avg_low',
  nhBanjir: 'avg',
  nhLongsor: 'avg',
  nhHistory: 'none',
  leMfl: '7',
};

// ============================================================
async function main() {
  console.log(`Target: ${BASE}\n`);

  // ---------- AUTH ----------
  const surveyor = await login(SURVEYOR);
  record('Auth: login surveyor', true, SURVEYOR.email);
  const me = await surveyor('GET', '/api/auth/me');
  record('Auth: GET /auth/me', me.status === 200 && me.json?.data?.user?.email === SURVEYOR.email, `status=${me.status}`);

  const badLogin = await client()('POST', '/api/auth/login', { email: SURVEYOR.email, password: 'salah' });
  record('Auth: password salah → 401', badLogin.status === 401, `status=${badLogin.status}`);

  const noAuth = await client()('GET', '/api/questions');
  record('Auth: tanpa login → 401', noAuth.status === 401, `status=${noAuth.status}`);

  // ---------- MASTER DATA ----------
  const occ = await surveyor('GET', '/api/occupations');
  const occupations = occ.json?.data?.occupations ?? occ.json?.data ?? [];
  record('Occupations: GET', occ.status === 200 && Array.isArray(occupations) && occupations.length > 0, `${occupations.length} okupasi`);

  const leaf = pickLeaf(occupations);
  record('Occupations: pilih okupasi daun', !!leaf, leaf ? `${leaf.code} — ${leaf.name.slice(0, 60)} (L${leaf.level})` : 'tidak ada daun!');

  const qs = await surveyor('GET', `/api/questions?occupationId=${leaf.id}`);
  const questions = qs.json?.data?.questions ?? [];
  record('Questions: GET wizard', qs.status === 200 && questions.length > 0, `${questions.length} pertanyaan`);

  // ---------- NEGATIVE: role & payload ----------
  const forbiddenStats = await surveyor('GET', '/api/stats');
  record('Role: surveyor akses /stats → 403', forbiddenStats.status === 403, `status=${forbiddenStats.status}`);

  const badStatus = await surveyor('POST', '/api/surveys', {
    property: { name: 'x', address: 'y', ownerName: 'z', occupationId: leaf.id },
    answers: [],
  });
  // seharusnya lolos schema (answers boleh 0..500? .max(500) tanpa min) → kalau 500 berarti bug lain
  record('Create survey: payload minimal (tanpa grading)', badStatus.status === 201 || badStatus.status === 400, `status=${badStatus.status} ${badStatus.text.slice(0, 120)}`);

  const badAnswer = await surveyor('POST', '/api/surveys', {
    property: { name: 'Negatif', address: 'y', ownerName: 'z', occupationId: leaf.id },
    answers: [{ questionId: questions.find((q) => q.answerType === 'NUMBER')?.id ?? 'x', value: 'bukan-angka' }],
  });
  record('Negative: jawaban NUMBER non-angka → 400', badAnswer.status === 400, `status=${badAnswer.status}`);

  const parentOcc = occupations.find((o) => o.level === 1);
  const notLeaf = await surveyor('POST', '/api/surveys', {
    property: { name: 'Negatif', address: 'y', ownerName: 'z', occupationId: parentOcc.id },
    answers: [],
  });
  record('Negative: okupasi non-daun → 400', notLeaf.status === 400, `status=${notLeaf.status}`);

  // ---------- ALUR UTAMA FE: buat survey lengkap ----------
  const answers = buildAnswers(questions);
  const payload = {
    property: {
      name: `Gedung E2E Test ${Date.now()}`,
      address: 'Jl. Test No. 123, Jakarta',
      ownerName: 'Pemilik Test',
      occupationId: leaf.id,
    },
    notes: 'Dibuat otomatis oleh scripts/e2e-test.mjs',
    answers,
    grading: { inputs: GRADING_INPUTS, notes: { management: 'catatan test' } },
  };
  const created = await surveyor('POST', '/api/surveys', payload);
  const surveyId = created.json?.data?.survey?.id;
  record('★ Create survey lengkap (property+answers+grading)', created.status === 201 && !!surveyId, `status=${created.status} ${created.text.slice(0, 300)}`);

  if (!surveyId) {
    console.log('\n⛔ Create survey gagal — alur berikutnya dilewati.');
    return finish();
  }

  // ---------- VERIFIKASI HASIL CREATE ----------
  const detail = await surveyor('GET', `/api/surveys/${surveyId}`);
  const sv = detail.json?.data?.survey;
  record('Survey: detail', detail.status === 200 && sv?.property?.name?.includes('E2E Test'), `status=${detail.status} answers=${sv?.answers?.length} grade=${sv?.grade ? `${sv.grade.totalScore}/${sv.grade.category}` : '-'}`);
  record('Survey: status awal ONBOARD', sv?.status === 'ONBOARD', `status=${sv?.status}`);
  record('Survey: grading tersimpan (skor server-side)', !!sv?.grade, sv?.grade ? `total=${sv.grade.totalScore} kategori=${sv.grade.category}` : 'tidak ada');

  const list = await surveyor('GET', '/api/surveys');
  record('Survey: list milik surveyor', list.status === 200 && list.json?.data?.surveys?.some((s) => s.id === surveyId), `status=${list.status}`);

  const gradeGet = await surveyor('GET', `/api/surveys/${surveyId}/grade`);
  record('Grading: GET /surveys/:id/grade', gradeGet.status === 200, `status=${gradeGet.status}`);

  const report = await surveyor('GET', `/api/reports/${surveyId}`);
  record('Reports: GET /reports/:surveyId', report.status === 200, `status=${report.status}`);

  // ---------- SURVEYOR TIDAK BISA UBAH STATUS ----------
  const survPatch = await surveyor('PATCH', `/api/surveys/${surveyId}/status`, { status: 'REVIEW' });
  record('Role: surveyor ubah status → 403', survPatch.status === 403, `status=${survPatch.status}`);

  // ---------- ALUR ADMIN ----------
  const admin = await login(ADMIN);
  record('Auth: login admin', true, ADMIN.email);

  // ---------- OTORISASI ANTAR-SURVEYOR ----------
  const SURVEYOR2 = { email: 'surveyor2@survey.local', password: 'surveyor234' };
  const reg = await admin('POST', '/api/auth/register', { ...SURVEYOR2, name: 'Surveyor Dua', role: 'SURVEYOR' });
  record('Auth: admin register surveyor2', reg.status === 200 || reg.status === 201 || reg.status === 409, `status=${reg.status}`);
  const s2 = await login(SURVEYOR2);
  record('Auth: login surveyor2', true, SURVEYOR2.email);

  const crossDetail = await s2('GET', `/api/surveys/${surveyId}`);
  record('Otorisasi: surveyor2 lihat survey surveyor1 → 403', crossDetail.status === 403, `status=${crossDetail.status}`);
  const crossReport = await s2('GET', `/api/reports/${surveyId}`);
  record('Otorisasi: surveyor2 akses report → 403', crossReport.status === 403, `status=${crossReport.status}`);
  const crossGrade = await s2('GET', `/api/surveys/${surveyId}/grade`);
  record('Otorisasi: surveyor2 akses grade → 403', crossGrade.status === 403, `status=${crossGrade.status}`);
  const crossAtt = await s2('GET', `/api/surveys/${surveyId}/attachments`);
  record('Otorisasi: surveyor2 akses attachments → 403', crossAtt.status === 403, `status=${crossAtt.status}`);
  const crossUpload = await s2('POST', `/api/surveys/${surveyId}/attachments`);
  record('Otorisasi: surveyor2 upload → 403', crossUpload.status === 403, `status=${crossUpload.status}`);

  // Upload nonaktif (R2 belum dikonfigurasi) → 503, bukan 500
  const attUpload = await surveyor('POST', `/api/surveys/${surveyId}/attachments`);
  record('Upload: nonaktif → 503 (bukan 500)', attUpload.status === 503, `status=${attUpload.status} ${attUpload.text.slice(0, 100)}`);

  const notifBefore = await admin('GET', '/api/notifications');
  const notifHasNew = JSON.stringify(notifBefore.json ?? {}).includes('Survei baru masuk');
  record('Notifications: admin dapat notif survey baru', notifBefore.status === 200 && notifHasNew, `status=${notifBefore.status}`);

  for (const next of ['REVIEW', 'GRADING']) {
    const tr = await admin('PATCH', `/api/surveys/${surveyId}/status`, { status: next });
    record(`Status: ONBOARD→…→${next}`, tr.status === 200, `status=${tr.status} ${tr.text.slice(0, 120)}`);
  }

  const invalidTr = await admin('PATCH', `/api/surveys/${surveyId}/status`, { status: 'ONBOARD' });
  record('Negative: transisi balik GRADING→ONBOARD → 400', invalidTr.status === 400, `status=${invalidTr.status}`);

  // admin override grading — schema: items[8] { itemCode, score 1..8 } + notes string
  const ITEM_CODES = ['management', 'construction', 'occupancy', 'protection', 'exposure', 'natural_hazards', 'other_peril', 'loss_estimate'];
  const override = await admin('POST', `/api/surveys/${surveyId}/grade`, {
    items: ITEM_CODES.map((itemCode) => ({ itemCode, score: 7 })),
    notes: 'override oleh admin',
  });
  record('Grading: admin override', override.status === 200 || override.status === 201, `status=${override.status} ${override.text.slice(0, 150)}`);

  // Override yang sukses otomatis memindah status ke DONE — sesuaikan langkah
  const cur = await admin('GET', `/api/surveys/${surveyId}`);
  const curStatus = cur.json?.data?.survey?.status;
  const remaining = curStatus === 'GRADING' ? ['DONE', 'CLOSED'] : ['CLOSED'];
  for (const next of remaining) {
    const tr = await admin('PATCH', `/api/surveys/${surveyId}/status`, { status: next });
    record(`Status: →${next}`, tr.status === 200, `status=${tr.status} ${tr.text.slice(0, 120)}`);
  }

  const stats = await admin('GET', '/api/stats');
  record('Stats: GET /stats (admin)', stats.status === 200, `status=${stats.status}`);

  const readAll = await admin('POST', '/api/notifications/read-all');
  record('Notifications: read-all', readAll.status === 200, `status=${readAll.status}`);

  // ---------- CLEANUP ----------
  const del = await admin('DELETE', `/api/surveys/${surveyId}`);
  record('Cleanup: DELETE survey (admin)', del.status === 200 || del.status === 204, `status=${del.status}`);

  return finish();
}

function finish() {
  const failed = results.filter((r) => !r.pass);
  console.log(`\n================ RINGKASAN ================`);
  console.log(`Total: ${results.length} | Pass: ${results.length - failed.length} | Fail: ${failed.length}`);
  if (failed.length) {
    console.log('Gagal:'); for (const f of failed) console.log(`  ❌ ${f.name} (${f.info})`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  finish();
  process.exit(1);
});
