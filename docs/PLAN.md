# BotPlatform — Phase 0: Reja

> Holat: **Phase 0 (reja)**. Kod yozilmagan. Bu hujjat tasdiqlangandan keyin Phase 1 boshlanadi.
> Manba: `botplatform-claude-code-prompt.md` (2 va 17-bo'limlar qat'iy).
> **Oxirgi yangilanish: 2026-08-29** — owner qarorlari bo'yicha sxema yangilandi (§0 ga qarang).

---

## 0. Qabul qilingan qarorlar (2026-08-29, owner tasdig'i)

Prompt'ning 5-bo'limidagi sxemadan **ataylab chetlashish** — owner tomonidan aniq ko'rsatilgan. Sabablari bilan:

| # | Qaror | Sabab | Sxemaga ta'siri |
|---|---|---|---|
| D1 | **Obuna har bot uchun alohida** (`Subscription.botId @unique` saqlanadi) | Xarajat ham, narx ham botga bog'liq: 15 000 foydalanuvchili kino bot bilan 200 foydalanuvchili do'kon boti bir xil resurs yemaydi. Owner darajasidagi obunada katta botlar kichiklari hisobidan subsidiya qilinadi. | O'zgarish yo'q |
| D2 | **Trial akkauntga bog'lanadi, botga emas** | Aks holda har 7 kunda yangi bot yaratib cheksiz bepul ishlash mumkin. | `Owner.trialUsedAt DateTime?`. Yangi bot yaratishda trial faqat `trialUsedAt IS NULL` bo'lsa beriladi va o'sha zahoti belgilanadi. |
| D3 | **Bitta to'lov bir nechta obunani qoplaydi** | 5 boti bor odam 5 marta karta kiritmasin. | `Invoice.subscriptionId` **olib tashlanadi**, o'rniga `InvoiceItem(invoiceId, subscriptionId, amount)`. |
| D4 | **Webhook secret shifrlanmaydi — HMAC-SHA256 hash qilinadi** | Shifrlash qiymatni *qaytarib olish* kerak bo'lganda ishlatiladi (token kabi — uni Telegram'ga yuborish shart). Webhook secret hech qachon qaytarib olinmaydi, faqat solishtiriladi; yo'qolsa yangisi generatsiya qilinib `setWebhook` qayta chaqiriladi. | `Bot`: `webhookSecretCipher/Iv/Tag` → `webhookSecretHash Bytes @unique` + `secretTokenHash Bytes`. **Token esa shifrlanganicha qoladi.** |
| D5 | **Webhook URL'da `publicId` ishlatilmaydi** | HMAC deterministik bo'lgani uchun hash bo'yicha to'g'ridan-to'g'ri qidirish mumkin. URL botning ichki ID'sini oshkor qilmaydi; proxy access-log'iga tushgan URL kam ma'lumot beradi. | `POST /tg/{random_48}` → `HMAC(pepper, random)` → `Bot WHERE webhookSecretHash = ...`. Redis kesh `tg:route:{hash} → botId`, TTL 1 soat. |
| D6 | **Pepper `.env` da emas** | Kalitlar alohida, huquqi cheklangan faylda turadi. | `ENCRYPTION_KEY` va `WEBHOOK_SECRET_PEPPER` — `secrets.env` (chmod 600), Docker `env_file` orqali. `.env` da faqat maxfiy bo'lmagan sozlamalar. |
| D7 | **Infra Docker'da, ilova dev'da native** | Versiya pariteti: prod'da PG16 bo'lsa dev'da ham PG16. `docker compose down -v` bilan bir zumda toza boshlash. Docker ichida hot-reload sekin va volume mount muammolari vaqt yeydi. | `postgres`, `redis`, **`minio`** — Docker'da birinchi kundan. `api`/`worker`/`web` — dev'da `pnpm dev`, prod'da Docker. |
| D8 | **Object storage = MinIO** | (Q15 javobi) Excel export va boshqa generatsiya qilingan fayllar uchun. | Prod'da S3-mos, dev'da MinIO konteyner. |

**Kelajak (hozir qurilmaydi):** agentliklar uchun "hisob tarifi" (N bot bitta narxda) kerak bo'lsa — `Subscription` ga `scope Enum('bot','account')` va nullable `ownerId` qo'shish yetarli. Hozirgi sxema buni buzmaydi, shuning uchun oldindan qurilmaydi.

**Nom moslashuvi** (owner SQL'i → shu loyihadagi Prisma modellari): `users` → `Owner`, `payments` → `Invoice`, `payment_items` → `InvoiceItem`, `bots` → `Bot`.

> Eslatma: owner javobida `uv run uvicorn` (Python) tilga olindi. Bu loyihada stek **TypeScript** (prompt 2-bo'limi, qat'iy) — Python komponenti yo'q. `pnpm` bo'yicha ko'rsatma qabul qilindi.

---

## 1. Loyiha qisqacha

Multi-tenant SaaS: owner (tenant) @BotFather tokenini panelga kiritadi, shablon tanlaydi — bot webhook rejimida ishga tushadi. Platforma runtime, DB va update processing'ni o'z zimmasiga oladi.

MVP doirasi: **Phase 1–5** — auth + panel + bot runtime + 4 shablon (Broadcast, Kino, Do'kon, Anketa) + billing + deploy.

---

## 2. Monorepo tuzilishi

Prompt 3-bo'limidagi skelet, fayl darajasida ochib berilgan. Papka nomlari o'zgartirilmagan.

```
botplatform/
├── apps/
│   ├── api/                          # Fastify 5
│   │   └── src/
│   │       ├── server.ts             # build() + listen, graceful shutdown
│   │       ├── plugins/              # cookie, helmet, rate-limit, prisma, redis, requestId
│   │       ├── hooks/                # auth guard, tenant resolver, error envelope
│   │       ├── routes/
│   │       │   ├── health.ts         # /health /ready /metrics
│   │       │   ├── auth.ts           # register|login|logout|telegram|google
│   │       │   ├── bots.ts           # CRUD + activate/suspend/token rotate
│   │       │   ├── stats.ts users.ts broadcasts.ts
│   │       │   ├── templates/        # movies|products|orders|surveys
│   │       │   ├── billing.ts merchant.ts
│   │       │   ├── telegram.ts       # POST /tg/:botPublicId
│   │       │   └── pay/{click,payme}.ts
│   │       └── index.ts
│   ├── worker/                       # BullMQ
│   │   └── src/
│   │       ├── index.ts              # worker bootstrap
│   │       ├── queues.ts             # queue nomlari va tiplar (bitta manba)
│   │       ├── jobs/
│   │       │   ├── broadcast.send.ts     # chunked, progress, retry
│   │       │   ├── stats.rollup.ts       # BotEvent -> DailyStat (soatlik)
│   │       │   ├── billing.tick.ts       # 10-bo'lim lifecycle
│   │       │   ├── export.excel.ts       # anketa/buyurtma export
│   │       │   └── cleanup.purge.ts      # grace tugagach hard delete
│   │       └── scheduler.ts          # repeatable jobs (cron)
│   └── web/                          # Next.js 15 App Router
│       └── src/app/
│           ├── (auth)/login|register|forgot-password
│           ├── (app)/dashboard|bots|billing|settings
│           │   └── bots/[id]/{overview,settings,texts,users,broadcast,payments,...}
│           └── (admin)/admin/*
├── packages/
│   ├── db/            # schema.prisma, migrations/, seed.ts, client.ts (singleton)
│   ├── core/          # crypto.ts, tenantGuard.ts, errors.ts, billing/, quota.ts, ids.ts
│   ├── telegram/      # client.ts, registry.ts, rateLimiter.ts (Lua), sendSafe.ts, helpers.ts
│   ├── templates/     # _contract.ts, registry.ts, broadcast/ kino/ shop/ survey/
│   ├── payments/      # provider.ts (interfeys), click/, payme/, amounts.ts (tiyin konvertatsiya)
│   └── shared/        # zod schemas, types, i18n/{uz,ru}.ts, constants.ts, errors codes
├── infra/             # docker-compose.dev.yml (postgres+redis+minio), docker-compose.prod.yml,
│                   #   Caddyfile, backup.sh, deploy.sh, secrets.env.example
├── docs/              # PLAN.md, RUNBOOK.md (Phase 6)
├── turbo.json, pnpm-workspace.yaml, tsconfig.base.json
├── .env.example
└── README.md
```

**Bog'liqlik yo'nalishi (bir tomonlama, tsiklsiz):**

```
shared  <-  db  <-  core  <-  telegram  <-  templates
                      ^          ^             ^
                      |          |             |
                   payments      +----  api / worker  ----+
                                              web -> (faqat shared tiplari)
```

Qoida: `templates/*` faqat `TemplateContext` orqali tashqi dunyoga chiqadi; `apps/*` domen mantiqini o'zida saqlamaydi.

---

## 3. Prisma schema loyihasi (to'liq)

> 5-bo'limdagi sxema asos qilib olindi. Qo'shilgani: `@relation` maydonlari, `created_at/updated_at`, cascade qoidalari, enum'lar, yetishmayotgan indekslar. **Maydon nomi yoki jadval qo'shilmagan/olib tashlanmagan** — faqat prompt'da tushirib qoldirilgan bog'lanishlar to'ldirildi. Ochiq savollar 5-bo'limda.

```prisma
generator client { provider = "prisma-client-js" }
datasource db    { provider = "postgresql"; url = env("DATABASE_URL") }

enum Role      { USER ADMIN SUPPORT }
enum BotStatus { DRAFT ACTIVE SUSPENDED GRACE DELETED }
enum SubStatus { TRIAL ACTIVE PAST_DUE GRACE CANCELED EXPIRED }

// ---------- Platforma yadrosi ----------
model Owner {
  id            String   @id @default(uuid())
  email         String?  @unique
  passwordHash  String?
  telegramId    BigInt?  @unique
  googleSub     String?  @unique
  fullName      String
  phone         String?
  locale        String   @default("uz")
  role          Role     @default(USER)
  status        String   @default("active")   // active | suspended | deleted
  lastLoginAt   DateTime?
  trialUsedAt   DateTime?                     // D2: trial akkauntga bog'liq — bir marta

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  deletedAt     DateTime?
  bots          Bot[]
  sessions      Session[]
  subscriptions Subscription[]
  invoices      Invoice[]
  auditLogs     AuditLog[]
}

model Session {
  id        String   @id @default(uuid())
  ownerId   String
  owner     Owner    @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  tokenHash String   @unique                  // sha256(token)
  ip        String?
  userAgent String?
  expiresAt DateTime
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@index([ownerId])
  @@index([expiresAt])
}

model Bot {
  id            String    @id @default(uuid())
  publicId      String    @unique             // nanoid(24) — panel/to'lov URL'lari (webhook URL emas, D5)
  ownerId       String
  owner         Owner     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  templateKey   String
  title         String
  tgBotId       BigInt
  tgUsername    String
  tokenCipher   Bytes
  tokenIv       Bytes
  tokenTag      Bytes
  tokenHash     String    @unique             // sha256(token) — dublikat aniqlash
  keyVersion    Int       @default(1)         // 6.2 key rotation — faqat token uchun
  // D4/D5: secretlar shifrlanmaydi, HMAC-SHA256(pepper, secret) hash qilinadi
  webhookSecretHash Bytes  @unique             // URL yo'lidagi random(48) hash'i — routing kaliti
  secretTokenHash   Bytes                      // X-Telegram-Bot-Api-Secret-Token hash'i
  adminIds      BigInt[]
  status        BotStatus @default(DRAFT)
  settings      Json
  texts         Json
  suspendedAt   DateTime?
  purgeAt       DateTime?
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  deletedAt     DateTime?

  botUsers      BotUser[]
  events        BotEvent[]
  dailyStats    DailyStat[]
  subscription  Subscription?
  merchantCreds MerchantCredential[]
  broadcasts    Broadcast[]
  movies        Movie[]
  requiredChannels RequiredChannel[]
  categories    Category[]
  products      Product[]
  carts         Cart[]
  orders        Order[]
  surveys       Survey[]

  @@index([ownerId, status])
  @@index([status, purgeAt])
}

model BotUser {
  id           String    @id @default(uuid())
  botId        String
  bot          Bot       @relation(fields: [botId], references: [id], onDelete: Cascade)
  tgUserId     BigInt
  username     String?
  firstName    String?
  languageCode String?
  status       String    @default("active")   // active | blocked_by_user | banned_by_admin
  referrerId   String?
  referrer     BotUser?  @relation("Referrals", fields: [referrerId], references: [id], onDelete: SetNull)
  referrals    BotUser[] @relation("Referrals")
  joinedAt     DateTime  @default(now())
  lastSeenAt   DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
  events       BotEvent[]
  carts        Cart[]
  orders       Order[]
  surveyResponses SurveyResponse[]
  broadcastTargets BroadcastTarget[]
  @@unique([botId, tgUserId])
  @@index([botId, joinedAt])
  @@index([botId, status])
}

model BotEvent {
  id        String   @id @default(uuid())
  botId     String
  bot       Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  botUserId String?
  botUser   BotUser? @relation(fields: [botUserId], references: [id], onDelete: SetNull)
  type      String
  payload   Json?
  createdAt DateTime @default(now())
  @@index([botId, type, createdAt])
}

model DailyStat {
  botId       String
  bot         Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  date        DateTime @db.Date
  newUsers    Int      @default(0)
  activeUsers Int      @default(0)
  messages    Int      @default(0)
  orders      Int      @default(0)
  revenue     Decimal  @default(0) @db.Decimal(14,2)
  updatedAt   DateTime @updatedAt
  @@id([botId, date])
}

model AuditLog {
  id        String   @id @default(uuid())
  ownerId   String?
  owner     Owner?   @relation(fields: [ownerId], references: [id], onDelete: SetNull)
  actorType String                    // owner | admin | system
  action    String                    // bot.create, token.rotate, payment.confirm ...
  target    String?
  meta      Json?
  ip        String?
  createdAt DateTime @default(now())
  @@index([ownerId, createdAt])
  @@index([action, createdAt])
}

// ---------- Billing ----------
model Plan {
  id           String  @id @default(uuid())
  code         String  @unique
  name         String
  monthlyPrice Decimal @db.Decimal(12,2)
  currency     String  @default("UZS")
  maxBotUsers  Int
  maxBots      Int     @default(1)
  features     Json
  isActive     Boolean @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  subscriptions Subscription[]
}

model Subscription {
  id                 String    @id @default(uuid())
  ownerId            String
  owner              Owner     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  botId              String    @unique
  bot                Bot       @relation(fields: [botId], references: [id], onDelete: Cascade)
  planId             String
  plan               Plan      @relation(fields: [planId], references: [id])
  status             SubStatus
  trialEndsAt        DateTime?
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  graceEndsAt        DateTime?
  canceledAt         DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt
  invoiceItems       InvoiceItem[]            // D3
  @@index([status, currentPeriodEnd])
  @@index([status, graceEndsAt])
  @@index([ownerId])
}

model Invoice {
  id             String   @id @default(uuid())
  // D3: subscriptionId olib tashlandi — bitta invoice bir nechta obunani qoplaydi
  ownerId        String
  owner          Owner    @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  amount         Decimal  @db.Decimal(12,2)
  currency       String   @default("UZS")
  status         String                    // pending | paid | canceled | failed
  provider       String?                   // click | payme | manual
  providerTxnId  String?
  paidAt         DateTime?
  dueAt          DateTime
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  transactions   PaymentTransaction[]
  items          InvoiceItem[]
  @@index([ownerId, status])
  @@index([status, dueAt])
}

model InvoiceItem {              // D3: owner SQL'idagi payment_items
  id             String   @id @default(uuid())
  invoiceId      String
  invoice        Invoice  @relation(fields: [invoiceId], references: [id], onDelete: Cascade)
  subscriptionId String
  subscription   Subscription @relation(fields: [subscriptionId], references: [id], onDelete: Cascade)
  amount         Decimal  @db.Decimal(12,2)   // UZS
  periodStart    DateTime                     // qaysi davr uchun to'lanmoqda
  periodEnd      DateTime
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([invoiceId, subscriptionId])       // bir invoice ichida takror obuna yo'q
  @@index([subscriptionId])
}

model PaymentTransaction {
  id            String   @id @default(uuid())
  invoiceId     String?
  invoice       Invoice? @relation(fields: [invoiceId], references: [id], onDelete: SetNull)
  provider      String                     // click | payme
  providerTxnId String
  state         Int
  amount        Decimal  @db.Decimal(14,2)
  rawRequest    Json
  performedAt   DateTime?
  canceledAt    DateTime?
  cancelReason  Int?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([provider, providerTxnId])       // idempotentlik kafolati
  @@index([invoiceId])
}

// ---------- Tenant merchant kalitlari ----------
model MerchantCredential {
  id           String  @id @default(uuid())
  botId        String
  bot          Bot     @relation(fields: [botId], references: [id], onDelete: Cascade)
  provider     String                       // click | payme
  isTest       Boolean @default(false)
  secretCipher Bytes
  secretIv     Bytes
  secretTag    Bytes
  keyVersion   Int     @default(1)
  publicMeta   Json                         // merchant_id, service_id, cashbox
  status       String  @default("active")
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([botId, provider, isTest])
}

// ---------- Shablon: Broadcast ----------
model Broadcast {
  id          String   @id @default(uuid())
  botId       String
  bot         Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  createdBy   BigInt
  content     Json
  audience    Json
  scheduledAt DateTime?
  status      String   @default("draft")    // draft|queued|running|paused|done|failed
  totalCount  Int      @default(0)
  sentCount   Int      @default(0)
  failedCount Int      @default(0)
  startedAt   DateTime?
  finishedAt  DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  targets     BroadcastTarget[]
  @@index([botId, status])
  @@index([status, scheduledAt])
}

model BroadcastTarget {
  id          String   @id @default(uuid())
  broadcastId String
  broadcast   Broadcast @relation(fields: [broadcastId], references: [id], onDelete: Cascade)
  botUserId   String
  botUser     BotUser  @relation(fields: [botUserId], references: [id], onDelete: Cascade)
  status      String   @default("pending")  // pending|sent|failed|skipped
  error       String?
  sentAt      DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@unique([broadcastId, botUserId])        // qayta yuborishdan himoya
  @@index([broadcastId, status])
}

// ---------- Shablon: Kino ----------
model Movie {
  id           String  @id @default(uuid())
  botId        String
  bot          Bot     @relation(fields: [botId], references: [id], onDelete: Cascade)
  code         String
  title        String
  description  String?
  year         Int?
  genres       String[]
  fileId       String                        // botga xos!
  fileUniqueId String?
  fileType     String                        // video | document
  fileSize     BigInt?
  views        Int     @default(0)
  isActive     Boolean @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  @@unique([botId, code])
  @@index([botId, title])
  // + raw SQL migratsiya: CREATE EXTENSION pg_trgm; GIN index on title (gin_trgm_ops)
}

model RequiredChannel {
  id        String  @id @default(uuid())
  botId     String
  bot       Bot     @relation(fields: [botId], references: [id], onDelete: Cascade)
  chatId    BigInt
  title     String
  inviteUrl String
  isActive  Boolean @default(true)
  sortOrder Int     @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([botId, chatId])
}

// ---------- Shablon: Do'kon ----------
model Category {
  id        String  @id @default(uuid())
  botId     String
  bot       Bot     @relation(fields: [botId], references: [id], onDelete: Cascade)
  title     String
  sortOrder Int     @default(0)
  isActive  Boolean @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  products  Product[]
  @@index([botId, sortOrder])
}

model Product {
  id          String   @id @default(uuid())
  botId       String
  bot         Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  categoryId  String?
  category    Category? @relation(fields: [categoryId], references: [id], onDelete: SetNull)
  title       String
  description String?
  price       Decimal  @db.Decimal(12,2)
  photoFileId String?
  stock       Int?                           // null = cheksiz
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([botId, isActive])
  @@index([categoryId])
}

model Cart {
  id        String   @id @default(uuid())
  botId     String
  bot       Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  botUserId String
  botUser   BotUser  @relation(fields: [botUserId], references: [id], onDelete: Cascade)
  items     Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  @@unique([botId, botUserId])
}

model Order {
  id            String   @id @default(uuid())
  botId         String
  bot           Bot      @relation(fields: [botId], references: [id], onDelete: Cascade)
  botUserId     String
  botUser       BotUser  @relation(fields: [botUserId], references: [id], onDelete: Cascade)
  number        Int                          // bot ichida ketma-ket
  items         Json                         // snapshot
  total         Decimal  @db.Decimal(12,2)
  deliveryType  String                       // pickup | delivery
  address       String?
  location      Json?
  phone         String
  comment       String?
  paymentMethod String                       // cash | click | payme
  paymentStatus String   @default("unpaid")  // unpaid | paid | refunded
  status        String   @default("new")     // new|confirmed|preparing|delivering|done|canceled
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@unique([botId, number])
  @@index([botId, status, createdAt])
}

// ---------- Shablon: Anketa ----------
model Survey {
  id           String  @id @default(uuid())
  botId        String
  bot          Bot     @relation(fields: [botId], references: [id], onDelete: Cascade)
  title        String
  isActive     Boolean @default(true)
  startTrigger String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
  questions    SurveyQuestion[]
  responses    SurveyResponse[]
  @@index([botId, isActive])
}

model SurveyQuestion {
  id         String  @id @default(uuid())
  surveyId   String
  survey     Survey  @relation(fields: [surveyId], references: [id], onDelete: Cascade)
  order      Int
  type       String                          // text|number|phone|choice|multi|photo|location
  prompt     String
  options    String[]
  required   Boolean @default(true)
  validation Json?
  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt
  @@unique([surveyId, order])
}

model SurveyResponse {
  id          String   @id @default(uuid())
  surveyId    String
  survey      Survey   @relation(fields: [surveyId], references: [id], onDelete: Cascade)
  botUserId   String
  botUser     BotUser  @relation(fields: [botUserId], references: [id], onDelete: Cascade)
  answers     Json
  completedAt DateTime?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  @@index([surveyId, completedAt])
}
```

**Phase 7 uchun joy qoldirilgan (hozir yozilmaydi):** `VipSubscription`, `PosTable`/`PosOrder`, `SupportTicket`/`SupportMessage`, `ReferralBalance`/`Payout`, `Contest`/`ContestEntry`. `templateKey` string bo'lgani uchun yangi shablon qo'shilganda yadro sxemasi o'zgarmaydi.

**Migratsiya eslatmalari:**
- `CREATE EXTENSION IF NOT EXISTS pg_trgm;` + `Movie.title` uchun GIN trgm indeks — qo'lda yozilgan SQL migratsiya.
- `Order.number` ketma-ketligi: `SELECT ... FOR UPDATE` yoki `advisory lock` bilan tranzaksiyada (unique constraint himoya sifatida).
- Barcha `Decimal` — `@db.Decimal`, hech qayerda `float` ishlatilmaydi.
- Purge (10.4) `onDelete: Cascade` orqali — bot o'chsa barcha bog'liq yozuvlar ketadi.

---

## 4. Asosiy texnik qarorlar (Phase 1 uchun aniqlashtirilgan)

| Mavzu | Qaror |
|---|---|
| Webhook URL | `POST /tg/{random_48}` (D5). Yo'ldagi random `A-Za-z0-9_-`, `publicId` oshkor qilinmaydi. |
| Webhook routing | `HMAC-SHA256(pepper, random)` → `tg:route:{hash}` Redis kesh (TTL 1 soat) → miss bo'lsa `Bot WHERE webhookSecretHash`. Solishtirish `timingSafeEqual`. |
| Webhook javobi | Har doim `200`, faqat secret/route noto'g'ri bo'lsa `401`. Og'ir ish → BullMQ. |
| Registry cache | `Map<botId, entry>` + TTL 15 daq + Redis pub/sub `botplatform:bot:invalidate` (route keshi ham shu signalda tozalanadi). |
| Rate limit | Redis Lua token bucket: global 25/s, chat 1/s, guruh 20/min. |
| Queue nomlari | `broadcast.send`, `stats.rollup`, `billing.tick`, `export.excel`, `cleanup.purge`. |
| Idempotentlik | To'lov: `(provider, providerTxnId)` unique. Cron: holat-mashinasi (o'tgan holatni qayta yozmaydi). |
| Crypto | **Token** — AES-256-GCM (qaytarib olinadi), `keyVersion` bilan ko'p kalit. **Secretlar** — HMAC-SHA256 + pepper (qaytarib olinmaydi). Ikkalasi ham `secrets.env` (chmod 600) dan o'qiladi, `.env` dan emas (D4/D6). |
| Object storage | MinIO (dev, Docker) / S3-mos (prod). Export fayllari — `exports/{botId}/{jobId}.xlsx`, presigned URL (D8). |
| Tenant guard | Repository qatlami majburiy `ownerId`/`botId` argument oladi; Prisma middleware test rejimida filtrsiz so'rovni throw qiladi. |
| Xato konverti | `{ ok, data }` / `{ ok, error: { code, message } }`, kodlar `packages/shared/errors.ts`. |
| i18n | `uz` default, `ru`; tenant matnlari `Bot.texts` (DB) i18n ustidan ustunlik qiladi. |

---

## 5. Ochiq savollar (kod yozishdan oldin javob kerak)

Prompt 0.3-qoidasi bo'yicha taxmin qilmayman. Quyidagilar sxemaga yoki biznes-mantiqqa ta'sir qiladi:

1. ~~**Obuna qamrovi.**~~ ✅ **HAL QILINDI (D1–D3):** har bot alohida to'laydi; trial akkauntga bog'lanadi (`Owner.trialUsedAt`); bitta invoice `InvoiceItem` orqali bir nechta obunani qoplaydi. → `Plan.maxBots` endi "bitta owner nechta bot yaratishi mumkin" limitidir (obuna qamrovi emas).
2. **Trial shartlari.** Trial necha kun? Har bot uchunmi yoki har owner uchun bir marta? Trial'da qaysi feature'lar yopiq (broadcast? payments?)?
3. **Tariflar ro'yxati.** Seed uchun aniq raqamlar kerak: kod, nom, oylik narx (UZS), `maxBotUsers`, `maxBots`, `features`. Prompt'da faqat kod namunalari bor (`standard_300`, `standard_1000`).
4. **Domen va TLS.** ⚠️ **PHASE 1 BLOKERI** — owner "buni Phase 0 da hal qiling" dedi, lekin aniq domen hali berilmagan. Yondashuv tanlandi (dev subdomen yoki cloudflared), kerak bo'lgani: (a) prod domen nomi, (b) dev subdomen (`dev.<domen>`) shu serverga yo'naltirilganmi yoki cloudflared tunnel bilan boshlaymizmi, (c) `api.` subdomeni ishlatiladimi yoki bitta domen ostida yo'l bo'yicha ajratamizmi.
5. **Platforma merchant hisobi.** Click/Payme test (sandbox) kalitlari bormi? Yo'q bo'lsa Phase 5 to'lovlarini faqat mock bilan test qilamiz — bu qabul mezoniga ta'sir qiladi.
6. **Google OAuth va SMTP.** Phase 2 uchun Google Client ID/Secret va SMTP mavjudmi? Yo'q bo'lsa Phase 2'da faqat email+parol va Telegram Login qilib, Google'ni keyinga qoldiramizmi?
7. **Bot adminlari.** `Bot.adminIds BigInt[]` — massiv oddiy, lekin "kim qo'shdi/qachon/qaysi huquq bilan" saqlanmaydi. Rollar (masalan faqat-o'qish admin) kerakmi? Kerak bo'lsa `BotAdmin` jadvali kerak bo'ladi.
8. ~~**`webhookSecret` saqlanishi.**~~ ✅ **HAL QILINDI (D4–D6):** shifrlash emas — deterministik HMAC-SHA256 + pepper, indekslangan `Bytes` ustunda; URL'dan `publicId` olib tashlandi; pepper `secrets.env` (chmod 600) da.
9. **Kvota oshganda.** 10.5: limit oshsa 7 kundan keyin yangi user qabul qilinmaydi. Bu holatda user `/start` bosganda unga qanday matn chiqadi? Owner'ga xabar qaysi kanal orqali — email, Telegram, yoki panel banner?
10. **Purge ogohlantirishi.** 10.4: o'chirishdan 24 soat oldin ogohlantirish. Owner Telegram'ini bermagan bo'lsa (faqat email bilan ro'yxatdan o'tgan) — email yetarlimi? Purge'dan oldin ma'lumot eksporti (JSON/Excel) taklif qilinadimi?
11. **Broadcast unsubscribe.** 19-bo'lim "obunani bekor qilish imkoni" talab qiladi. Bu `/stop` buyrug'imi, har xabar ostidagi tugmami, yoki ikkalasi? Unsubscribe holati `BotUser.status` ichidami yoki alohida maydonmi (hozirgi enum'da bunday qiymat yo'q)?
12. **Kino: avtomatik o'chirish.** 8.2 "ixtiyoriy" deydi — MVP'ga kiritamizmi? Kiritsak, standart necha daqiqa?
13. **Do'kon: yetkazib berish narxi.** `Order` sxemasida `deliveryFee` yo'q, faqat `total`. Yetkazish puli kerakmi? Kerak bo'lsa `total` ichiga kiradimi yoki alohida maydonmi?
14. **Valyuta.** Hamma joyda UZS deb qat'iy hisoblaymizmi (Payme tiyin konvertatsiyasi shunga bog'liq), yoki tenant boshqa valyuta tanlashi mumkinmi?
15. ~~**Excel export saqlanishi.**~~ ✅ **QISMAN HAL QILINDI (D8):** MinIO / S3-mos storage. **Qoldi:** presigned havola muddati qancha (taklifim: 1 soat, faqat panel sessiyasi orqali olinadi)?
16. **Ma'lumot saqlash muddati.** `BotEvent` tez o'sadi. Retention qancha (masalan 90 kun, keyin faqat `DailyStat` qoladi)? Partitioning kerakmi?

> **Blokerlar:** 1, 2, 3 — Phase 5'gacha kutishi mumkin, lekin 1-savol **Phase 1 sxemasiga** ta'sir qiladi, shuning uchun Phase 1 boshlanishidan oldin javob kerak. 8-savol ham Phase 1 sxemasiga tegishli. Qolganlari o'z Phase'igacha kutadi.

---

## 6. Texnik risklar va yumshatish

| # | Risk | Ta'sir | Yumshatish |
|---|---|---|---|
| R1 | **`file_id` botga bog'liq** (18.1) | Kino/mahsulot fayllari bot almashtirilsa yo'qoladi; token rotate ham xavfli | Fayl faqat o'sha bot orqali yuklanadi; panelda ochiq ogohlantirish; token rotate'da `getMe.id` o'zgarganini tekshirish (boshqa bot = fayllar ishlamaydi → bloklash) |
| R2 | **Telegram rate limit / 429** | Broadcast sekinlashadi, xabarlar yo'qoladi | Lua token bucket, `retry_after` hurmati, eksponensial backoff (maks 5), `BroadcastTarget` per-user holat — qayta ishga tushirish idempotent |
| R3 | **Webhook 200-har-doim qoidasi xatolarni yashiradi** | Jimgina yo'qolgan update'lar | Har bir xato Sentry + `BotEvent(type='error')`; 15-bo'lim alert (5 daq / 50 xato) |
| R4 | **Multi-bot memory** — yuzlab `Bot` instance bir process'da | RAM, GC bosimi | Registry TTL 15 daq + LRU cheklovi; grammY instance lazy yaratiladi; `api` 2 replica |
| R5 | **Tenant izolyatsiyasi buzilishi** | Eng og'ir xavfsizlik xatosi | `tenantGuard` + Prisma middleware; har bir repository funksiyasiga majburiy `ownerId`; testda "boshqa owner ma'lumoti" scenariysi (16-bo'lim) |
| R6 | **To'lov callback'i takrorlanishi / poyga** | Ikki marta to'lov, noto'g'ri holat | `(provider, providerTxnId)` unique + tranzaksiya ichida `SELECT FOR UPDATE`; barcha raw payload saqlanadi |
| R7 | **Payme tiyin konvertatsiyasi** | 100x xato — real pul yo'qotish | Konvertatsiya faqat `packages/payments/amounts.ts` da, `Decimal` bilan; float ishlatilmaydi; unit test chegara qiymatlar bilan |
| R8 | **Kalit rotatsiyasi (key rotation)** | Eski kalit yo'qolsa barcha tokenlar o'lik | `keyVersion` boshidanoq sxemada (qo'shildi); `rotate-keys` skripti + dry-run; kalitlar backup protsedurasi RUNBOOK'da |
| R9 | **`Order.number` poyga sharoitida dublikat** | Buyurtma raqami takrorlanadi | `@@unique([botId, number])` + advisory lock; retry |
| R10 | **BullMQ job yo'qolishi / worker crash** | Broadcast yarim qoladi | Per-target holat DB'da; job `attempts` + backoff; `running` broadcast'lar worker start'da qayta tiklanadi |
| R11 | **Cron idempotent emasligi** (billing) | Ikki marta invoice, noto'g'ri suspend | Holat mashinasi + `WHERE status = X` shartli update; `billing.tick` testi soxta vaqt bilan (16-bo'lim) |
| R12 | **Prisma `Bytes` + `BigInt` serializatsiyasi** | JSON javobda crash | `shared` da `BigInt.toString()` serializer; API javoblarida `Bytes` hech qachon chiqmaydi |
| R13 | **Muhitda pnpm/Docker yo'q** (quyida "Muhit holati") | Phase 1 qabul mezoni bajarilmaydi | ✅ Qaror D7: `corepack enable pnpm` + Docker Desktop o'rnatiladi; infra (PG16, Redis, MinIO) Docker'da, ilova dev'da native |
| R14 | **Next.js 15 + Node 24 mosligi** | Prompt Node 22 LTS talab qiladi, mashinada 24 | `.nvmrc` = 22, Docker image `node:22`; lokalda 22'ga tushish tavsiya etiladi |
| R15 | **Dev'da webhook uchun HTTPS yo'q** | Phase 3 qabul mezoni ("haqiqiy token bilan `/start`") sinovdan o'tmaydi | Yondashuv tanlandi: `dev.<domen>` serverga yo'naltiriladi yoki cloudflared tunnel (ngrok'dan barqarorroq). **Domen hali berilmagan — 4-savol, Phase 1 blokeri** |
| R17 | **Route hash yo'qolsa bot "yo'qoladi"** — HMAC qaytarib olinmaydi, faqat hash saqlanadi | Webhook URL'ni qayta tiklab bo'lmaydi | Bu qasddan: yo'qolsa yangi random generatsiya qilinib `setWebhook` qayta chaqiriladi (D4 mantiqi). `POST /api/bots/:id/webhook/rotate` endpoint'i Phase 3 da |
| R18 | **Pepper almashtirilsa barcha route hash'lari yaroqsiz bo'ladi** | Barcha botlar webhook'ni qabul qilmay qoladi | Pepper rotatsiyasi = barcha botlar uchun ommaviy `setWebhook` qayta chaqirish. RUNBOOK'da alohida protsedura; pepper backup'i kalit backup'i bilan bir xil darajada muhim |
| R19 | **`InvoiceItem` bilan qisman to'lov** (5 obunadan 3 tasi to'landi) | Noto'g'ri obuna aktivlashishi | Invoice atomik: yo hammasi `paid`, yo hech biri. Provayder callback'ida barcha `items` bitta tranzaksiyada yangilanadi |
| R16 | **`BotEvent` o'sishi** | DB shishadi, panel sekinlashadi | Panel faqat `DailyStat` dan o'qiydi; retention siyosati (16-savol) |

---

## 7. Muhit holati (tekshirildi)

| Vosita | Holat | Izoh |
|---|---|---|
| Node.js | ✅ v24.16.0 | Prompt **22 LTS** talab qiladi → `.nvmrc`=22 va Docker `node:22`. Lokalda 22'ga o'tish tavsiya. |
| pnpm | ❌ topilmadi | **Phase 1 blokeri:** `corepack enable pnpm`. |
| Docker | ❌ topilmadi | **Phase 1 blokeri:** infra D7 bo'yicha Docker'da. |
| PostgreSQL | ✅ 17.10 (Homebrew) | Docker'da **16** ishlatiladi (prod pariteti, D7). Lokal 17 ishlatilmaydi. |
| Redis | ➡️ Docker | D7. |
| MinIO | ➡️ Docker | D8. |
| Git | ✅ 2.54.0 | ✅ Init qilindi, `main` branch, `origin` = `github.com/NodirbekIskandarov/safo-bot_clone`. |

---

## 8. Phase 1 ish rejasi (tasdiqdan keyin)

Branch: `phase/01-foundation`. Ketma-ketlik (har biri alohida commit):

1. `chore: init monorepo` — pnpm workspace, turborepo, tsconfig base, ESLint/Prettier, husky+lint-staged, `.nvmrc` (22), `.gitignore`, `.env.example`, `secrets.env.example`.
2. `chore: dev infra` — `infra/docker-compose.dev.yml`: postgres**:16**, redis:7, minio (D7/D8). Faqat infra — ilova native.
3. `feat(db): prisma schema + migration` — §3 dagi sxema (D1–D5 bilan), `pnpm db:migrate`.
4. `feat(db): raw migration` — `pg_trgm` extension + `Movie.title` GIN trgm indeks.
5. `feat(db): seed` — planlar (**3-savol javobi kerak**), demo owner.
6. `feat(core): crypto` — AES-256-GCM + `keyVersion` (token) **va** `hmacSecret()` (webhook secret/pepper, D4) + unit testlar.
7. `feat(core): tenantGuard + errors` + unit testlar (boshqa owner ma'lumotiga kirish doim throw).
8. `feat(api): fastify skeleton` — helmet, cookie, rate-limit, pino (redact: token/password/secret/authorization), requestId, `/health`, `/ready`, xato konverti.
9. `test: vitest setup + CI-ready script`.
10. `docs: README + .env.example + secrets.env.example`.

**Qabul mezoni:** `docker compose -f infra/docker-compose.dev.yml up -d` → `pnpm dev` → `/health` 200; `pnpm build` xatosiz; `pnpm test` yashil; migratsiya toza DB'da ishlaydi; `secrets.env` git'ga tushmaydi (`.gitignore` da).

---

## 9. Tasdiq so'rovi

✅ Hal qilindi: obuna modeli (D1–D3), webhook secret (D4–D6), infra (D7–D8), `git init` + `origin`.

⚠️ **Phase 1 boshlanishidan oldin hali kerak:**

1. **Domen** (4-savol) — prod domen nomi va dev'da webhook qanday keladi: `dev.<domen>` serverga yo'naltiriladimi yoki cloudflared tunnel? Bu Phase 3 gacha kod yozishga xalal bermaydi, lekin owner "Phase 0 da hal qiling" dedi.
2. **Trial muddati** (2-savol) — necha kun? Trial'da qaysi feature'lar ochiq (broadcast? payments?)? Seed va `billing.tick` shunga bog'liq.
3. **Tariflar** (3-savol) — seed uchun aniq ro'yxat: `code`, nom, oylik narx (UZS), `maxBotUsers`, `maxBots`, `features`.

> 2 va 3 faqat **Phase 1 ning 5-commit'iga** (seed) to'siq. 1–4 va 6–10 commitlar ularsiz ham boshlanaveradi.

Qolgan savollar (5, 6, 7, 9–14, 16) o'z Phase'igacha kutadi va hozir bloklamaydi.
