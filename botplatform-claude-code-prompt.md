# Claude Code uchun PROMPT — "BotPlatform" (multi-tenant Telegram bot yaratish platformasi)

> Bu faylni to'liq holda Claude Code'ga bering (`claude` ochib, faylni `@botplatform-claude-code-prompt.md` sifatida ilova qiling yoki matnini birinchi xabar sifatida joylashtiring).

---

## 0. SENGA (Claude Code'ga) ISH QOIDALARI

Sen bu loyihada senior backend + platform engineer rolidasan. Quyidagi qoidalarga qat'iy amal qil:

1. **Bosqichma-bosqich ishla.** Faqat 17-bo'limdagi joriy Phase'ni bajar. Phase tugagach — **TO'XTA**, qilingan ishni, ishlab turgan qismini va keyingi qadamni qisqa hisobot qilib ber, tasdiq kutib tur. Bir urinishda butun loyihani yozma.
2. **Steki va sxemani o'zgartirma.** 2- va 5-bo'limdagi tanlovlar qat'iy. Boshqa kutubxona/arxitektura yaxshiroq deb hisoblasang — avval sabab bilan so'ra, ruxsatsiz almashtirma.
3. **Taxmin qilma.** Aniq bo'lmagan biznes qoida chiqsa — kod yozishdan oldin savol ber. Yolg'on API, mavjud bo'lmagan endpoint yoki "shunday bo'lsa kerak" degan sxema yozish taqiqlanadi.
4. **Har bir Phase oxirida:** migratsiyalar ishlaydi, `pnpm build` xatosiz o'tadi, testlar yashil, `README.md` va `.env.example` yangilangan bo'lishi shart.
5. **Xavfsizlik birinchi o'rinda.** Token, parol, merchant kalit — hech qachon log'ga, xato matniga, frontend javobiga tushmasin. Har bir DB so'rovi tenant bo'yicha filtrlangan bo'lsin.
6. **Test yoz.** Har bir biznes-mantiq moduli uchun unit test, har bir to'lov callback'i va webhook uchun integration test majburiy.
7. **Kod tili:** kod, o'zgaruvchi, jadval nomlari, kommentariyalar — **ingliz tilida**. Foydalanuvchiga ko'rinadigan matnlar — **o'zbekcha (default) va ruscha** i18n fayllarida.
8. **Git:** har bir Phase alohida branch (`phase/01-foundation`), conventional commits (`feat:`, `fix:`, `chore:`), har bir mantiqiy qadam alohida commit.
9. **Huquqiy chegara:** bu mustaqil ishlanma. Boshqa platformaning kodi, matni, logotipi, dizayni yoki brend nomi nusxalanmaydi. Faqat funksional g'oyalar takrorlanadi.

---

## 1. LOYIHA MAQSADI

O'zbekiston bozori uchun **multi-tenant SaaS platforma**: foydalanuvchi dasturchisiz Telegram bot yaratadi. U @BotFather'dan token oladi, panelga kiritadi, tayyor shablon tanlaydi — bot bir necha daqiqada ishlay boshlaydi. Server, ma'lumotlar bazasi, update'larni qayta ishlash — platforma tomonida.

**Asosiy tushunchalar:**

| Termin | Ma'no |
|---|---|
| **Owner (tenant)** | Platformada ro'yxatdan o'tgan mijoz. Bir nechta bot egasi bo'lishi mumkin. |
| **Bot** | Owner yaratgan Telegram bot instance'i: token + shablon + sozlamalar. |
| **Template** | Shablon (kino, do'kon, broadcast...). Har biri plug-in modul. |
| **Bot user (end user)** | Owner botidan foydalanadigan Telegram foydalanuvchisi. Platforma hisobiga ega emas. |
| **Plan / Subscription** | Owner'ning oylik tarifi va uning holati. |

**MVP doirasi (Phase 1–5):** auth + panel + bot runtime + 4 ta shablon (**Broadcast, Kino, Do'kon, Anketa**) + billing + deploy.
**Keyingi bosqich (Phase 6+):** Kafe POS, VIP kanal, Aloqa, Referal, Konkurs, Tarjimon shablonlari.

---

## 2. TEXNOLOGIYA STEKI (qat'iy)

- **Til:** TypeScript 5.x (strict: true), Node.js 22 LTS
- **Monorepo:** pnpm workspaces + Turborepo
- **Bot runtime:** [grammY](https://grammy.dev) (webhook rejimi, multi-bot)
- **API server:** Fastify 5 (+ `@fastify/cookie`, `@fastify/helmet`, `@fastify/rate-limit`)
- **DB:** PostgreSQL 16 + Prisma ORM (migrations bilan)
- **Cache / queue:** Redis 7 + BullMQ (broadcast, cron, retry)
- **Dashboard:** Next.js 15 (App Router) + Tailwind + shadcn/ui + TanStack Query
- **Validatsiya:** Zod (barcha input: API, bot sozlamalari, webhook payload)
- **Auth:** session cookie (httpOnly, SameSite=Lax) + Argon2id parol hash
- **Log:** pino (JSON), xatolar uchun Sentry (ixtiyoriy, env orqali yoqiladi)
- **Test:** Vitest (unit) + Supertest (API) + Testcontainers yoki docker-compose test DB
- **Deploy:** Docker Compose + Caddy (avtomatik TLS) o'z serveringda
- **Format:** ESLint + Prettier, pre-commit uchun husky + lint-staged

> Eslatma: Python/aiogram varianti ham mumkin, lekin bu loyihada **TypeScript tanlandi** — dashboard va bot runtime bitta tilda bo'lishi uchun. O'zgartirma.

---

## 3. MONOREPO TUZILISHI

```
botplatform/
├── apps/
│   ├── api/                 # Fastify: REST API + Telegram webhook receiver
│   ├── worker/              # BullMQ worker: broadcast, cron, billing, cleanup
│   └── web/                 # Next.js dashboard (panel)
├── packages/
│   ├── db/                  # Prisma schema, migrations, seed, typed client
│   ├── core/                # domain logic: billing, quota, crypto, tenant guard
│   ├── telegram/            # grammY wrapper, bot registry, rate limiter, helpers
│   ├── templates/           # bot shablonlari (plug-in modullar)
│   │   ├── _contract.ts     # BotTemplate interfeysi
│   │   ├── broadcast/
│   │   ├── kino/
│   │   ├── shop/
│   │   └── survey/
│   ├── payments/            # Click, Payme provayderlari + umumiy interfeys
│   └── shared/              # zod sxemalar, tiplar, i18n, konstantalar
├── infra/
│   ├── docker-compose.yml
│   ├── Caddyfile
│   └── backup.sh
├── .env.example
└── README.md
```

---

## 4. ARXITEKTURA

### 4.1 Update oqimi (webhook)

```
Telegram → POST https://<domain>/tg/:botPublicId
         → secret_token header tekshiruvi
         → bot registry'dan Bot instance (cache)
         → template handler (tez javob: <1s, 200 OK)
         → og'ir ish (broadcast, export, to'lov) → BullMQ queue
```

**Majburiy texnik detallar:**

- Har bot uchun `setWebhook(url, { secret_token, allowed_updates, drop_pending_updates: true })`.
- `secret_token` — bot yaratilganda generatsiya qilinadigan 32 baytlik random (faqat `A-Za-z0-9_-`). Har so'rovda `X-Telegram-Bot-Api-Secret-Token` header'i bilan solishtiriladi (timing-safe compare). Mos kelmasa — **401**, log'ga yozib qo'y.
- URL'dagi `botPublicId` — DB'dagi ketma-ket ID emas, **UUID/nanoid**. Token URL'ga hech qachon qo'yilmaydi.
- Webhook faqat HTTPS va 443/80/88/8443 portlarda ishlaydi.
- Javob **har doim 200** qaytarsin (xato bo'lsa ham) — aks holda Telegram qayta yuboraveradi. Xato ichkarida log + Sentry'ga ketadi.
- Update'ning og'ir qismi worker'ga o'tadi; webhook handler'da faqat tez javob va DB yozuvi.

### 4.2 Bot registry

- `packages/telegram/registry.ts`: `Map<botPublicId, { bot: Bot, settings, loadedAt }>`, TTL 15 daqiqa.
- Sozlama o'zgarganda API `botplatform:bot:invalidate` kanaliga Redis pub/sub xabar yuboradi → barcha api instance'lar cache'ni tozalaydi. **Restart kerak emas** — bu mahsulot va'dasi.
- Bot statusi `active` bo'lmasa registry uni yuklamaydi va webhook 200 (ignore) qaytaradi.

### 4.3 Rate limiting (Telegram cheklovlari)

Redis'da Lua script bilan **token bucket**, har bot uchun alohida:

- Global: **25 msg/sek** (Telegram limiti ~30, xavfsizlik zaxirasi bilan).
- Bir chat uchun: **1 msg/sek**.
- Guruh/kanal uchun: **20 msg/daqiqa**.
- `429` kelsa — `parameters.retry_after` bo'yicha kutib, exponential backoff bilan qayta urin (maks 5 marta).
- `403 Forbidden: bot was blocked by the user` → `bot_users.status = 'blocked'`, qayta urinilmaydi.
- `400 chat not found` / `user is deactivated` → `status = 'inactive'`.

---

## 5. MA'LUMOTLAR BAZASI SXEMASI

Prisma schema. Barcha jadvallarda `id` (uuid), `created_at`, `updated_at`. Soft-delete kerak bo'lgan joyda `deleted_at`.

### 5.1 Platforma yadrosi

```prisma
model Owner {              // platforma mijozi
  id            String   @id @default(uuid())
  email         String?  @unique
  passwordHash  String?
  telegramId    BigInt?  @unique
  googleSub     String?  @unique
  fullName      String
  phone         String?
  locale        String   @default("uz")
  role          Role     @default(USER)      // USER | ADMIN | SUPPORT
  status        String   @default("active")  // active | suspended | deleted
  lastLoginAt   DateTime?
  bots          Bot[]
  subscriptions Subscription[]
}

model Session {
  id        String   @id @default(uuid())
  ownerId   String
  tokenHash String   @unique     // sessiya tokeni faqat hash holida
  ip        String?
  userAgent String?
  expiresAt DateTime
}

model Bot {
  id             String  @id @default(uuid())
  publicId       String  @unique          // webhook URL uchun nanoid(24)
  ownerId        String
  templateKey    String                   // "kino" | "shop" | "broadcast" | "survey" ...
  title          String
  tgBotId        BigInt                   // getMe.id
  tgUsername     String
  tokenCipher    Bytes                    // AES-256-GCM
  tokenIv        Bytes
  tokenTag       Bytes
  tokenHash      String  @unique          // sha256(token) — dublikatni aniqlash uchun
  webhookSecret  String                   // shifrlangan holda saqlanadi
  adminIds       BigInt[]                 // bot adminlari (Telegram ID)
  status         BotStatus @default(DRAFT) // DRAFT|ACTIVE|SUSPENDED|GRACE|DELETED
  settings       Json                     // shablonga xos sozlamalar (zod bilan validatsiya)
  texts          Json                     // tahrirlanadigan matnlar/tugmalar
  suspendedAt    DateTime?
  purgeAt        DateTime?                // suspend + 7 kun
  @@index([ownerId, status])
}

model BotUser {            // bot foydalanuvchisi (end user)
  id            String  @id @default(uuid())
  botId         String
  tgUserId      BigInt
  username      String?
  firstName     String?
  languageCode  String?
  status        String  @default("active") // active | blocked_by_user | banned_by_admin
  referrerId    String?
  joinedAt      DateTime @default(now())
  lastSeenAt    DateTime?
  @@unique([botId, tgUserId])
  @@index([botId, joinedAt])
}

model BotEvent {           // yengil analitika (message, start, order, payment ...)
  id        String   @id @default(uuid())
  botId     String
  botUserId String?
  type      String
  payload   Json?
  createdAt DateTime @default(now())
  @@index([botId, type, createdAt])
}

model DailyStat {          // agregat (panel grafiklari shu jadvaldan o'qiydi)
  botId       String
  date        DateTime @db.Date
  newUsers    Int      @default(0)
  activeUsers Int      @default(0)
  messages    Int      @default(0)
  orders      Int      @default(0)
  revenue     Decimal  @default(0) @db.Decimal(14,2)
  @@id([botId, date])
}

model AuditLog {
  id        String   @id @default(uuid())
  ownerId   String?
  actorType String                    // owner | admin | system
  action    String                    // bot.create, token.rotate, payment.confirm ...
  target    String?
  meta      Json?
  ip        String?
  createdAt DateTime @default(now())
}
```

### 5.2 Billing

```prisma
model Plan {
  id           String  @id @default(uuid())
  code         String  @unique        // trial | standard_300 | standard_1000 | business_...
  name         String
  monthlyPrice Decimal @db.Decimal(12,2)
  currency     String  @default("UZS")
  maxBotUsers  Int                    // tarif bo'yicha foydalanuvchi limiti
  maxBots      Int     @default(1)
  features     Json                   // { broadcast: true, payments: true, sms: false }
  isActive     Boolean @default(true)
}

model Subscription {
  id         String   @id @default(uuid())
  ownerId    String
  botId      String   @unique
  planId     String
  status     SubStatus                // TRIAL|ACTIVE|PAST_DUE|GRACE|CANCELED|EXPIRED
  trialEndsAt DateTime?
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  graceEndsAt DateTime?
  canceledAt  DateTime?
}

model Invoice {
  id             String   @id @default(uuid())
  subscriptionId String
  ownerId        String
  amount         Decimal  @db.Decimal(12,2)
  currency       String   @default("UZS")
  status         String                 // pending | paid | canceled | failed
  provider       String?                // click | payme | manual
  providerTxnId  String?
  paidAt         DateTime?
  dueAt          DateTime
  @@index([ownerId, status])
}

model PaymentTransaction {   // provayder callback'lari uchun (idempotent)
  id            String   @id @default(uuid())
  invoiceId     String?
  provider      String                  // click | payme
  providerTxnId String
  state         Int                     // provayder holati (Payme: 1,2,-1,-2)
  amount        Decimal  @db.Decimal(14,2)
  rawRequest    Json
  performedAt   DateTime?
  canceledAt    DateTime?
  cancelReason  Int?
  @@unique([provider, providerTxnId])
}
```

### 5.3 Tenant to'lov kalitlari (mijoz o'z pulini o'zi oladi)

```prisma
model MerchantCredential {
  id           String  @id @default(uuid())
  botId        String
  provider     String                  // click | payme
  isTest       Boolean @default(false)
  // barcha maxfiy maydonlar AES-256-GCM bilan shifrlanadi:
  secretCipher Bytes
  secretIv     Bytes
  secretTag    Bytes
  publicMeta   Json                    // merchant_id, service_id, cashbox (maxfiy emas)
  status       String  @default("active")
  @@unique([botId, provider, isTest])
}
```

### 5.4 Shablon jadvallari

```prisma
// --- Broadcast ---
model Broadcast {
  id          String @id @default(uuid())
  botId       String
  createdBy   BigInt                  // admin tgUserId
  content     Json                    // { type: text|photo|video, text, fileId, buttons[] }
  audience    Json                    // { all: true } | { onlyActive: true, joinedAfter: date }
  scheduledAt DateTime?
  status      String @default("draft") // draft|queued|running|paused|done|failed
  totalCount  Int    @default(0)
  sentCount   Int    @default(0)
  failedCount Int    @default(0)
  startedAt   DateTime?
  finishedAt  DateTime?
}
model BroadcastTarget {
  id          String @id @default(uuid())
  broadcastId String
  botUserId   String
  status      String @default("pending") // pending|sent|failed|skipped
  error       String?
  sentAt      DateTime?
  @@index([broadcastId, status])
}

// --- Kino ---
model Movie {
  id          String @id @default(uuid())
  botId       String
  code        String                   // foydalanuvchi kiritadigan kod
  title       String
  description String?
  year        Int?
  genres      String[]
  fileId      String                   // MUHIM: file_id har bir botga xos!
  fileUniqueId String?
  fileType    String                   // video | document
  fileSize    BigInt?
  views       Int    @default(0)
  isActive    Boolean @default(true)
  @@unique([botId, code])
  @@index([botId, title])
}
model RequiredChannel {                // majburiy obuna
  id        String @id @default(uuid())
  botId     String
  chatId    BigInt
  title     String
  inviteUrl String
  isActive  Boolean @default(true)
  sortOrder Int     @default(0)
}

// --- Do'kon ---
model Category { id String @id @default(uuid()) botId String; title String; sortOrder Int @default(0); isActive Boolean @default(true) }
model Product {
  id          String @id @default(uuid())
  botId       String
  categoryId  String?
  title       String
  description String?
  price       Decimal @db.Decimal(12,2)
  photoFileId String?
  stock       Int?                     // null = cheksiz
  isActive    Boolean @default(true)
}
model Cart { id String @id @default(uuid()) botId String; botUserId String; items Json; updatedAt DateTime @updatedAt; @@unique([botId, botUserId]) }
model Order {
  id            String @id @default(uuid())
  botId         String
  botUserId     String
  number        Int                      // bot ichida ketma-ket: 1,2,3...
  items         Json                     // snapshot: title, price, qty
  total         Decimal @db.Decimal(12,2)
  deliveryType  String                   // pickup | delivery
  address       String?
  location      Json?                    // { lat, lon }
  phone         String
  comment       String?
  paymentMethod String                   // cash | click | payme
  paymentStatus String @default("unpaid") // unpaid | paid | refunded
  status        String @default("new")    // new|confirmed|preparing|delivering|done|canceled
  @@unique([botId, number])
  @@index([botId, status, createdAt])
}

// --- Anketa ---
model Survey { id String @id @default(uuid()) botId String; title String; isActive Boolean @default(true); startTrigger String? }
model SurveyQuestion {
  id        String @id @default(uuid())
  surveyId  String
  order     Int
  type      String                      // text | number | phone | choice | multi | photo | location
  prompt    String
  options   String[]
  required  Boolean @default(true)
  validation Json?                      // { min, max, regex }
}
model SurveyResponse { id String @id @default(uuid()) surveyId String; botUserId String; answers Json; completedAt DateTime? }
```

> **Diqqat:** `file_id` faqat uni yuklagan bot uchun amal qiladi. Shuning uchun kino/mahsulot fayllari **har bir tenant o'z boti orqali** yuklanadi va shu bot orqali qayta yuboriladi. Fayllarni bir botdan boshqasiga ko'chirib bo'lmaydi — bu cheklovni panelda foydalanuvchiga tushuntir.

---

## 6. XAVFSIZLIK TALABLARI

1. **Token shifrlash:** AES-256-GCM, kalit `ENCRYPTION_KEY` (32 bayt, base64) env'da. `packages/core/crypto.ts` da `encrypt()/decrypt()`. Token faqat Telegram API chaqiruvi paytida xotirada ochiladi. Log'ga, API javobiga, xato matniga hech qachon tushmaydi (pino redact ro'yxatiga qo'sh).
2. **Kalit almashtirish (key rotation):** `key_version` maydoni bilan bir nechta kalitni qo'llab-quvvatla; `pnpm rotate-keys` skripti yoz.
3. **Tenant izolyatsiyasi:** `packages/core/tenantGuard.ts` — har bir repository funksiyasi majburiy `ownerId` argumenti oladi. Prisma middleware bilan `botId` bo'yicha filtr yo'q so'rovlarni test rejimida xato qilib tashla.
4. **Auth:** Argon2id (memoryCost ≥ 19456), sessiya tokeni 32 bayt random, DB'da faqat sha256 hash. Login uchun rate-limit: 5 urinish / 15 daqiqa / IP + email.
5. **Telegram Login Widget** tekshiruvi: `hash` = HMAC-SHA256(data_check_string, sha256(bot_token)), `auth_date` 24 soatdan eski bo'lmasin.
6. **Webhook:** secret_token timing-safe compare, body hajmi limiti 1MB, JSON schema validatsiyasi.
7. **CSRF:** panel mutatsiyalari uchun double-submit cookie yoki SameSite=Strict + origin tekshiruvi.
8. **Merchant callback'lar:** Click uchun `sign_string` MD5 tekshiruvi, Payme uchun Basic auth (`Paycom:KEY`) va IP allowlist (env orqali sozlanadi).
9. **Idempotentlik:** har bir to'lov callback'i `(provider, providerTxnId)` unique constraint bilan himoyalanadi.
10. **Backup:** kunlik `pg_dump` (gzip), 14 kun saqlash, `infra/backup.sh` + cron. Tiklashni test qil.

---

## 7. TEMPLATE ENGINE KONTRAKTI

`packages/templates/_contract.ts`:

```ts
export interface BotTemplate<S extends z.ZodTypeAny = z.ZodTypeAny> {
  key: string;                         // "kino"
  name: { uz: string; ru: string };
  description: { uz: string; ru: string };
  settingsSchema: S;                   // zod — panel formasi shu asosda generatsiya qilinadi
  defaultSettings: z.infer<S>;
  defaultTexts: Record<string, { uz: string; ru: string }>;
  requiredPlanFeatures?: string[];     // masalan ["payments"]
  register(ctx: TemplateContext): void; // grammY handler'larni ro'yxatga oladi
  onInstall?(ctx: TemplateContext): Promise<void>;
  onUninstall?(ctx: TemplateContext): Promise<void>;
  adminMenu?: AdminMenuItem[];         // bot ichidagi admin panel
}

export interface TemplateContext {
  bot: Bot<BotContext>;
  botId: string;
  settings: unknown;
  t: (key: string, vars?: Record<string, string>) => string; // tenant matnlari + i18n
  db: PrismaClient;
  queue: QueueClient;
  api: TelegramHelpers;   // sendSafe(), checkSubscription(), createInviteLink()...
}
```

Qoidalar:
- Har bir shablon **faqat o'z jadvallari** bilan ishlaydi; boshqa shablon jadvaliga tegmaydi.
- Har bir shablon `settingsSchema` ni eksport qiladi — panel formasi qo'lda emas, shu sxemadan generatsiya qilinadi.
- Yangi shablon qo'shish = yangi papka + registry'ga bitta qator. Yadro kodiga tegilmaydi.

---

## 8. SHABLONLAR — FUNKSIONAL TALABLAR

### 8.1 Broadcast bot (eng sodda — birinchi bo'lib shu qilinadi)
- `/start` → foydalanuvchi `BotUser` sifatida saqlanadi, `referrerId` deep-link'dan (`?start=ref_<code>`).
- Admin (adminIds ichidagi) uchun bot ichida menyu: "Xabar yuborish", "Statistika", "Foydalanuvchilar".
- Xabar turlari: matn, rasm+matn, video, forward. Inline tugmalar (matn + URL) qo'shish.
- Rejalashtirilgan yuborish (`scheduledAt`), pauza/davom ettirish, bekor qilish.
- Yuborish worker'da: 25 msg/sek, progress har 500 ta xabarda DB'ga yoziladi, panelda jonli progress bar.
- Yakuniy hisobot: yuborildi / bloklangan / xato.

### 8.2 Kino bot
- Majburiy obuna: `RequiredChannel` ro'yxati, `getChatMember` orqali tekshiruv, natija Redis'da 5 daqiqa cache. Obuna bo'lmasa — kanallar tugmasi + "Tekshirish" tugmasi.
- Foydalanuvchi kod yuboradi → `Movie` topiladi → `copyMessage`/`sendVideo` `file_id` bilan → `views++`, `BotEvent`.
- Nom bo'yicha qidiruv: Postgres `pg_trgm` + GIN indeks, `similarity()` bo'yicha top-10 tugma ko'rinishida.
- Admin bot ichida: video yuborib kod va nom kiritish orqali kino qo'shish (wizard/conversation). Panel orqali ham CRUD.
- Statistika: eng ko'p ko'rilgan kinolar, kunlik faollik.
- Ixtiyoriy: fayl yuborilgandan N daqiqa keyin avtomatik o'chirish (`deleteMessage`), copyright uchun.

### 8.3 Do'kon bot
- Katalog → kategoriya → mahsulot (rasm, narx, tavsif) → savatga qo'shish (miqdor +/-).
- Savat → buyurtma rasmiylashtirish: ism, telefon (`request_contact`), yetkazib berish turi, manzil yoki `request_location`, izoh.
- To'lov: naqd / Click / Payme (tenant o'z kalitlari bilan). To'lov muvaffaqiyatli bo'lsa `paymentStatus = paid` va adminga xabar.
- Adminga yangi buyurtma xabari + inline tugmalar: "Tasdiqlash", "Bekor qilish", "Yetkazildi" → status o'zgaradi va mijozga avtomatik xabar boradi.
- Panelda: mahsulot CRUD (rasm yuklash bot orqali `file_id` olinadi), buyurtmalar ro'yxati, filtr, Excel export.

### 8.4 Anketa bot
- Savol turlari: matn, raqam, telefon, bitta tanlov, ko'p tanlov, rasm, lokatsiya.
- Bosqichma-bosqich so'rov (state Redis'da, TTL 1 soat), "Orqaga" tugmasi, validatsiya xatolari.
- Natijalar panelda jadval ko'rinishida + **Excel export** (`exceljs`, worker'da generatsiya, tayyor bo'lgach havola).
- Bir foydalanuvchi bir marta yoki ko'p marta topshirishi — sozlamada.

### 8.5 Keyingi bosqich shablonlari (Phase 6+, hozir qurma, faqat sxema joyini qoldir)
- **VIP kanal:** to'lovdan keyin `createChatInviteLink({ member_limit: 1, expire_date })`, obuna muddati tugashidan 3 kun oldin eslatma, tugagach `banChatMember` + darhol `unbanChatMember` (kelajakda qayta kirishi uchun). Bot kanalda admin bo'lishi shart — `getChatMember` bilan tekshirib, bo'lmasa panelda ogohlantirish.
- **Kafe POS:** menyu, stol raqami (QR deep-link `?start=table_12`), oshxonaga buyurtma, kunlik z-hisobot.
- **Aloqa:** murojaat → operatorlar guruhiga forward, javob `reply` orqali mijozga qaytadi, tiket tarixi.
- **Referal:** ko'p bosqichli (2 daraja), balans, pul yechish so'rovi, vazifalar.
- **Konkurs:** shartlar (kanalga obuna, do'st taklif qilish), tasodifiy g'olib (crypto.randomInt, natija audit log'ga).
- **Tarjimon:** tashqi tarjima API (provider abstraktsiya bilan), til aniqlash.

---

## 9. TO'LOV TIZIMI

**Ikki xil to'lov oqimi bor — ularni chalkashtirma:**

**A) Platforma obunasi** (mijoz → sen). Platformaning o'z Click/Payme merchant hisobi. Invoice → to'lov → `Subscription.status = ACTIVE`, `currentPeriodEnd += 1 oy`.

**B) Tenant savdosi** (bot mijozi → tenant). Tenant o'z Click/Payme kalitini panelga kiritadi, pul to'g'ridan-to'g'ri unga tushadi, platforma komissiya olmaydi. Platforma faqat callback'ni qabul qilib, buyurtmani `paid` deb belgilaydi.

### 9.1 Provider interfeysi

```ts
export interface PaymentProvider {
  key: 'click' | 'payme';
  createInvoiceUrl(input: { amount: number; orderId: string; returnUrl?: string; creds: Creds }): string;
  handleCallback(req: FastifyRequest, creds: Creds): Promise<CallbackResult>;
}
```

### 9.2 Click (Merchant API)
- Ikki bosqich: **Prepare** va **Complete** (`action=0` va `action=1`).
- Imzo tekshiruvi: `sign_string = md5(click_trans_id + service_id + SECRET_KEY + merchant_trans_id + amount + action + sign_time)`. Mos kelmasa `error = -1`.
- Xato kodlari: `-2` (noto'g'ri summa), `-4` (allaqachon to'langan), `-5` (buyurtma topilmadi), `-9` (bekor qilingan). Javob JSON'i Click formatiga to'liq mos bo'lsin.
- Endpoint: `POST /pay/click/:botPublicId/prepare` va `/complete`; platforma obunasi uchun `/pay/click/platform/...`.

### 9.3 Payme (Merchant API, JSON-RPC 2.0)
- Basic auth: `Authorization: Basic base64("Paycom:" + KEY)`.
- Metodlar: `CheckPerformTransaction`, `CreateTransaction`, `PerformTransaction`, `CancelTransaction`, `CheckTransaction`, `GetStatement`, `ChangePassword` — **hammasini** amalga oshir.
- Summa **tiyinda** (1 so'm = 100 tiyin). Konvertatsiyani bitta joyda qil.
- Xato kodlari: `-31001` (noto'g'ri summa), `-31050..-31099` (buyurtma topilmadi), `-31008` (holat noto'g'ri), `-32504` (auth).
- Transaction timeout: 12 soat (`CreateTransaction` dan keyin `PerformTransaction` kelmasa `state = -1`).
- Barcha callback'lar `PaymentTransaction` jadvaliga raw holida yoziladi.

### 9.4 Testlar (majburiy)
Har ikki provayder uchun sandbox scenariylari: to'liq to'lov, ikki marta kelgan callback (idempotentlik), noto'g'ri imzo, noto'g'ri summa, bekor qilish, timeout.

---

## 10. BILLING LIFECYCLE (cron, worker'da)

`billing.tick` — har soatda:

1. `TRIAL` va `trialEndsAt < now()` → `PAST_DUE`, invoice yaratiladi, owner'ga email + Telegram xabar.
2. `PAST_DUE` va to'lov yo'q → `GRACE`, `graceEndsAt = now() + 7 kun`, **bot to'xtatiladi**: `deleteWebhook`, `Bot.status = SUSPENDED`, registry'dan chiqariladi. Foydalanuvchiga panelda aniq ogohlantirish.
3. `GRACE` ichida to'lov kelsa → bot **avvalgi holatida** qayta ishga tushadi (`setWebhook`, `status = ACTIVE`). Hech qanday ma'lumot yo'qolmaydi.
4. `graceEndsAt` o'tsa → `purgeAt` belgilanadi va **hard delete**: bot va unga tegishli barcha jadvallar (cascade), fayl havolalari. O'chirishdan 24 soat oldin oxirgi ogohlantirish yuboriladi. O'chirish `AuditLog`da qoladi.
5. Kvota nazorati: `maxBotUsers` oshib ketsa yangi `/start` bloklanmaydi, lekin owner'ga "tarifni oshiring" ogohlantirishi yuboriladi va 7 kundan keyin yangi foydalanuvchi qabul qilinmaydi (bu qoidani sozlanadigan qil).
6. Sinov tarifida: kuniga 100 tagacha yangi foydalanuvchi (`DailyStat.newUsers` bo'yicha tekshiruv).

Barcha cron'lar **idempotent** bo'lsin (bir necha marta ishlasa ham natija bir xil).

---

## 11. DASHBOARD (Next.js) SAHIFALARI

```
/login, /register, /forgot-password        — email+parol, Telegram Login, Google OAuth
/dashboard                                  — umumiy: faol botlar, bugungi yangi userlar, buyurtmalar
/bots                                       — botlar ro'yxati (status badge, tarif, muddat)
/bots/new                                   — 4 qadamli wizard (pastda)
/bots/[id]/overview                         — grafiklar (7/30/90 kun), oxirgi hodisalar
/bots/[id]/settings                         — shablon settingsSchema'dan generatsiya qilingan forma
/bots/[id]/texts                            — bot matnlari va tugmalari editori (o'zgargach darhol kuchga kiradi)
/bots/[id]/users                            — ro'yxat, qidiruv, bloklash, CSV export
/bots/[id]/broadcast                        — yuborish, rejalashtirish, jonli progress
/bots/[id]/<template-specific>              — /movies, /products, /orders, /surveys
/bots/[id]/payments                         — Click/Payme kalitlari (write-only maydonlar, oxirgi 4 belgi ko'rinadi)
/billing                                    — tarif, invoice tarixi, to'lov
/settings/profile, /settings/security       — parol, sessiyalar, 2FA (keyinchalik)
/admin/*                                    — faqat platforma admini: ownerlar, botlar, to'lovlar, tizim holati
```

**Bot yaratish wizard'i (4 qadam):**
1. Shablon tanlash (kartochkalar bilan).
2. Token kiritish → darhol `getMe` bilan tekshiriladi (username, id ko'rsatiladi), token band bo'lmaganligi tekshiriladi.
3. Admin ID kiritish → "Botga /start bosing, biz ID'ni avtomatik olamiz" varianti ham bo'lsin.
4. Sozlamalar → "Ishga tushirish" → `setWebhook` → jonli holat ko'rsatkichi.

UI talablari: mobil-first (foydalanuvchilarning ko'pi telefondan kiradi), skeleton loading, optimistic update, xatolar o'zbekcha tushunarli tilda. Dark tema default.

---

## 12. API ENDPOINTLAR (Fastify)

```
POST   /tg/:botPublicId                    # Telegram webhook (secret header)
POST   /pay/click/:scope/prepare|complete   # scope = platform | bot_<publicId>
POST   /pay/payme/:scope                    # JSON-RPC

POST   /api/auth/register|login|logout|telegram|google
GET    /api/me
GET    /api/bots                 POST /api/bots
GET    /api/bots/:id             PATCH /api/bots/:id      DELETE /api/bots/:id
POST   /api/bots/:id/activate    POST /api/bots/:id/suspend
POST   /api/bots/:id/token       # token almashtirish (rotate)
GET    /api/bots/:id/stats?from&to&granularity
GET    /api/bots/:id/users       PATCH /api/bots/:id/users/:userId  (ban/unban)
POST   /api/bots/:id/broadcasts  GET/PATCH /api/bots/:id/broadcasts/:bid
CRUD   /api/bots/:id/movies | /products | /orders | /surveys
PUT    /api/bots/:id/merchant/:provider
GET    /api/billing/plans | /invoices        POST /api/billing/invoices/:id/pay
GET    /health  /ready  /metrics             # metrics — Prometheus formatida
```

Barcha `/api/*` javoblari bir xil konvertda: `{ ok: true, data }` yoki `{ ok: false, error: { code, message } }`. Xato kodlari `packages/shared/errors.ts` da ro'yxatlanadi.

---

## 13. DEPLOY (o'z serveringda)

`infra/docker-compose.yml` servislari: `caddy`, `api` (2 replica), `worker`, `web`, `postgres`, `redis`.

- **Caddy** avtomatik Let's Encrypt sertifikat oladi; `api` faqat ichki tarmoqda.
- Postgres va Redis portlari tashqariga chiqmaydi (`expose`, `ports` emas).
- `postgres` uchun volume + kunlik backup cron (`infra/backup.sh`, 14 kun saqlash).
- Healthcheck: `api` → `/health`, restart policy `unless-stopped`.
- Migratsiya konteyner start'ida emas, alohida `pnpm db:migrate:deploy` buyrug'i bilan (deploy skriptida).
- `deploy.sh`: git pull → build → migrate → rolling restart.
- Log rotatsiyasi: Docker `json-file` driver, `max-size: 10m`, `max-file: 3`.
- Ixtiyoriy: **local Bot API server** (`telegram-bot-api`) — 50MB'dan katta fayl yuklash uchun. Env orqali yoqiladigan qilib qo'y (`TELEGRAM_API_ROOT`).

---

## 14. .env.example (to'liq bo'lsin)

```env
NODE_ENV=production
APP_URL=https://<domen>
API_PORT=3001
WEB_PORT=3000

DATABASE_URL=postgresql://bp:***@postgres:5432/botplatform
REDIS_URL=redis://redis:6379

SESSION_SECRET=            # 32+ bayt random
ENCRYPTION_KEY=            # base64, 32 bayt — token shifrlash
ENCRYPTION_KEY_VERSION=1

TELEGRAM_API_ROOT=https://api.telegram.org
PLATFORM_BOT_TOKEN=        # panel bildirishnomalari va Telegram login uchun
PLATFORM_ADMIN_CHAT_ID=

GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

CLICK_SERVICE_ID=
CLICK_MERCHANT_ID=
CLICK_SECRET_KEY=
PAYME_MERCHANT_ID=
PAYME_KEY=
PAYME_ALLOWED_IPS=

SENTRY_DSN=
LOG_LEVEL=info
SMTP_URL=
```

---

## 15. OBSERVABILITY

- pino structured log; har bir so'rovda `requestId`, `botId`, `ownerId`. `redact: ['*.token', '*.password', '*.secret', 'headers.authorization']`.
- `/metrics`: update soni, o'rtacha handler vaqti, queue uzunligi, 429 soni, bot bo'yicha xatolar.
- Alert (Telegram orqali platforma adminiga): webhook xatolari 5 daqiqada 50 tadan oshsa, queue 10k dan oshsa, DB ulanmasa, to'lov callback'i 3 marta ketma-ket xato bo'lsa.

---

## 16. TESTLAR VA QABUL MEZONLARI

Minimal qamrov:
- `crypto` (encrypt/decrypt, key rotation) — unit
- `tenantGuard` — boshqa owner ma'lumotiga kirishga urinish **doim** xato qaytarishi
- webhook: noto'g'ri secret → 401, to'g'ri secret → 200, noma'lum bot → 200 (ignore)
- rate limiter: 429 da retry_after hurmat qilinishi
- broadcast: 1000 ta foydalanuvchida bloklangani `failed` emas `blocked` bo'lishi
- billing: trial → past_due → grace → purge zanjiri (soxta vaqt bilan)
- Click va Payme: 9-bo'limdagi barcha scenariylar
- E2E (Playwright): ro'yxatdan o'tish → bot yaratish → sozlash → test xabar

---

## 17. BOSQICHLAR (har biri oxirida TO'XTA va hisobot ber)

**Phase 0 — Reja.** Kod yozma. Monorepo tuzilishi, Prisma schema loyihasi, ochiq savollar ro'yxati va risklarni `docs/PLAN.md` ga yoz. Tasdiq so'ra.

**Phase 1 — Poydevor.** Monorepo, Docker Compose (postgres, redis), Prisma schema (5-bo'lim) + migratsiya + seed (planlar, demo owner), `packages/core` (crypto, tenantGuard, errors), Fastify skeleton, `/health`, log, testlar sozlangan.
*Qabul mezoni:* `docker compose up` → `/health` 200, `pnpm test` yashil.

**Phase 2 — Auth va panel skeleti.** Register/login (email+parol), sessiya, Telegram Login Widget, Google OAuth, Next.js layout, `/dashboard`, `/bots` bo'sh holatlar bilan.
*Qabul mezoni:* ro'yxatdan o'tib panelga kirish mumkin, sessiya cookie xavfsiz.

**Phase 3 — Bot runtime.** Bot CRUD, token validatsiya (`getMe`) va shifrlash, `setWebhook`/`deleteWebhook`, webhook receiver + secret tekshiruvi, bot registry + Redis invalidatsiya, `BotUser` yozish, rate limiter, `sendSafe()` (429/403 ishlovi), **Broadcast shablon** (8.1).
*Qabul mezoni:* haqiqiy token bilan bot yaratilib, `/start` ishlaydi, 1000 ta foydalanuvchiga broadcast progress bilan ketadi.

**Phase 4 — Shablonlar.** Kino (8.2), Do'kon (8.3), Anketa (8.4) + ularning panel sahifalari + Excel export + statistika (DailyStat agregatsiyasi cron bilan).
*Qabul mezoni:* har uch shablonda to'liq foydalanuvchi yo'li oxirigacha ishlaydi.

**Phase 5 — Billing va to'lovlar.** Planlar, obuna, invoice, Click va Payme (platforma + tenant), lifecycle cron (10-bo'lim), `/billing` sahifasi.
*Qabul mezoni:* sandbox to'lov o'tadi, trial→grace→purge zanjiri testda ishlaydi.

**Phase 6 — Deploy va mustahkamlash.** Caddy + TLS, backup, metrics, alert, E2E testlar, `docs/RUNBOOK.md` (incident, restore, rollback).
*Qabul mezoni:* domenda ishlaydi, backup tiklanishi tekshirilgan.

**Phase 7 — Qolgan shablonlar.** VIP kanal, Kafe POS, Aloqa, Referal, Konkurs, Tarjimon — bittalab, har biri alohida PR.

---

## 18. TELEGRAM API TUZOQLARI (bularni oldindan hisobga ol)

1. `file_id` **botga xos** — boshqa bot bilan ishlatib bo'lmaydi. `file_unique_id` esa yuklab olishga yaramaydi.
2. Bot API orqali yuklash limiti 50MB (local Bot API server bilan 2GB). Mavjud faylni `file_id` bilan qayta yuborishda bu limit yo'q.
3. Webhook va long polling birga ishlamaydi — `getUpdates` konfliktiga tushmaslik uchun faqat webhook ishlat.
4. Bir bot uchun bitta webhook URL. Token almashtirilganda eski webhook o'chiriladi.
5. Kanaldan foydalanuvchini chiqarish: `banChatMember` → darhol `unbanChatMember` (aks holda umuman qaytib kira olmaydi).
6. `getChatMember` bot kanalda admin bo'lmasa xato beradi — bot yaratishda tekshir.
7. Inline tugma `callback_data` maksimal 64 bayt — uzun ma'lumotni Redis'ga saqlab, kalitni uzat.
8. Xabar matni 4096 belgidan oshmasin, caption 1024 belgidan.
9. Foydalanuvchi ismidagi HTML/Markdown belgilarini escape qil (parse_mode bilan xatolikka olib keladi).
10. `answerCallbackQuery` ni **har doim** chaqir, aks holda tugmada aylanma qotib qoladi.

---

## 19. NIMA QILINMAYDI

- Boshqa platformaning kodi, matni, dizayni yoki brendi nusxalanmaydi.
- Foydalanuvchi tokeni bilan platforma o'z nomidan xabar yubormaydi.
- Bot foydalanuvchilarining ma'lumotlari tenantlar o'rtasida umumiy bo'lmaydi va uchinchi tomonga berilmaydi.
- Spam yuborish uchun vosita qilinmaydi: broadcast faqat `/start` bosgan foydalanuvchilarga, "obunani bekor qilish" imkoni bilan.

---

## 20. BIRINCHI BUYRUQ

Hozir **faqat Phase 0** ni bajar: `docs/PLAN.md` yoz — monorepo tuzilishi, to'liq Prisma schema loyihasi, ochiq savollaring ro'yxati (kamida 10 ta) va texnik risklar. Kod yozma, tasdiq kutib tur.
