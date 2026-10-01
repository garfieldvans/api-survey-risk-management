# Deploy survey-api ke Vercel

Project ini **mandiri** (tanpa monorepo / workspace). Backend Fastify + Prisma + PostgreSQL (Neon).

## 1. Siapkan database (Neon)

1. Buka https://neon.tech → buat project (mis. `survey-reports`)
2. Copy **Connection string** (pooler), format:
   `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/dbname?sslmode=require`
3. Migrasi & seed (sekali saja, dari komputer lokal):
   ```bash
   cp .env.example .env    # isi DATABASE_URL & JWT_SECRET
   pnpm install
   pnpm db:deploy          # jalankan migrasi
   pnpm db:seed            # isi data awal (user admin, pertanyaan, okupasi)
   ```

## 2. Deploy ke Vercel

1. Push repo ini ke GitHub (repo terpisah, mis. `survey-api`)
2. Vercel → **Add New Project** → import repo `survey-api`
3. Framework: terdeteksi otomatis (Fastify). Build command sudah di `vercel.json`.
4. **Sebelum deploy pertama**, tambahkan Environment Variables (Production + Preview):

   | Name | Value |
   |------|-------|
   | `DATABASE_URL` | connection string Neon (pooler) |
   | `JWT_SECRET` | string acak panjang (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `WEB_ORIGIN` | URL web, mis. `https://survey-web.vercel.app` |
   | `R2_*` (opsional) | isi jika pakai upload Cloudflare R2 |

5. Deploy.

## 3. Verifikasi

- `https://<api-url>.vercel.app/api/health` → `{"status":"ok"}`
- Kalau muncul `ServerInitError` + nama env var → env itu belum di-set → tambah → **Redeploy**
- Login dari web akan mengirim cookie; `WEB_ORIGIN` harus persis URL web (tanpa trailing slash).

## Dev lokal

```bash
pnpm install
cp .env.example .env   # isi DATABASE_URL, JWT_SECRET
pnpm dev               # http://localhost:4000 (health: /health dan /api/health)
```

Cookie di production memakai `SameSite=None; Secure` (aman untuk web & API di domain berbeda).
Di lokal otomatis `Lax` (http).
