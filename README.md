# BotPlatform

Telegram orqali **dasturchisiz bot yaratish** platformasi. Foydalanuvchi @BotFather'dan token oladi,
sizning platforma botingizga yuboradi, shablon tanlaydi — bot bir necha soniyada ishlay boshlaydi.

Tashqi servis talab qilmaydi: Docker, Postgres, Redis, domen, TLS — hech biri kerak emas.

---

## Ishga tushirish (3 qadam)

### 1. Platforma boti uchun token oling

Telegram'da [@BotFather](https://t.me/BotFather):

```
/newbot
→ nom:      BotPlatform
→ username: sizning_platforma_bot
```

BotFather bergan tokenni nusxalang.

### 2. `.env` fayliga yozing

```bash
PLATFORM_BOT_TOKEN=1234567890:AAF...   # 1-qadamdagi token
PLATFORM_ADMIN_IDS=123456789            # o'z Telegram ID'ingiz (@userinfobot beradi)
```

`ENCRYPTION_KEY` allaqachon generatsiya qilingan. **Uni o'zgartirmang** — o'zgartirsangiz
saqlangan barcha bot tokenlari ochilmay qoladi.

### 3. Ishga tushiring

```bash
npm install      # bir marta
npm run db:push  # bir marta — bazani yaratadi
npm start
```

Platforma botingizni oching va `/start` bosing.

---

## Buyruqlar

| Buyruq | Vazifasi |
|---|---|
| `npm start` | Platformani ishga tushirish |
| `npm run dev` | Ishga tushirish + kod o'zgarsa avtomatik qayta yuklash |
| `npm run check` | O'z-o'zini tekshirish (shifrlash, baza, shablonlar) |
| `npm run build` | TypeScript tekshiruvi |
| `npm run db:studio` | Bazani brauzerda ko'rish |
| `npm run keygen` | Yangi shifrlash kaliti generatsiya qilish |

---

## Shablonlar

| | Shablon | Nima qiladi | Tarif |
|---|---|---|---|
| 🎬 | **Kino** | Kod yuboradi → kino keladi. Majburiy obuna, ko'rishlar hisobi | har qanday |
| 🛒 | **Do'kon** | Katalog → savat → buyurtma. Bir tugmada tasdiqlash | biznes |
| 📢 | **Reklama** | Obunachilar yig'adi, hammasiga xabar yuboradi | har qanday |
| 📅 | **Navbat** | Sartaroshxona/klinika: xizmat → kun → soat. Band vaqtlar ko'rinmaydi | har qanday |
| 💬 | **Aloqa** | Mijoz yozadi → sizga keladi → javobingiz qaytadi. Tiket raqami bilan | har qanday |
| 🎁 | **Konkurs** | Bilet raqami, majburiy obuna, `crypto.randomInt` bilan g'olib | har qanday |
| 🤖 | **Savol-javob** | Kalit so'z bo'yicha avtomatik javob beradi | har qanday |
| 📋 | **Anketa** | Bosqichma-bosqich savollar, javoblarni CSV qilib yuklab olish | har qanday |

Yangi shablon qo'shish: `src/templates/<nom>/index.ts` yarating va
`src/templates/index.ts` ga bitta qator qo'shing. Yadro kodiga tegilmaydi.

---

## Foydalanuvchi yo'li

```
Platforma boti                      Yaratilgan bot
─────────────                       ──────────────
/start                              /start        → oddiy foydalanuvchi oqimi
➕ Bot yaratish                      /admin        → egasi uchun panel:
  → shablon tanlash                                  • kontent qo'shish
  → token yuborish                                   • 📢 xabar yuborish
  → 🎉 bot ishlaydi                                  • 📊 statistika
🤖 Mening botlarim                                   • 👥 foydalanuvchilar
  → to'xtatish / o'chirish
  → salomlashuv matni
```

---

## To'lov tizimi

Click/Payme emas — **karta orqali qo'lda tasdiqlash**. Yuridik shaxs va shartnoma kerak emas.

```
Mijoz                                 Siz (admin)
─────                                 ───────────
🤖 Mening botlarim → 💳 To'lov
  → tarif tanlaydi
  → karta raqami + summa chiqadi
  → pul o'tkazadi
  → chek skrinshotini tashlaydi   ──► 🧾 xabar keladi
                                      ✅ Tasdiqlash / ❌ Rad etish
  ◄── "to'lov tasdiqlandi"        ◄──  bot darhol ishga tushadi
```

Karta raqamini `/panel → 💳 Karta` orqali o'rnatasiz — kodga tegmasdan istalgan vaqt o'zgartiriladi.

### Obuna hayot sikli

| Holat | Nima bo'ladi |
|---|---|
| `trial` | 7 kun bepul. **Akkauntga bir marta** — ikkinchi bot uchun darhol to'lov kerak |
| `active` | To'langan, 30 kun |
| `grace` | Muddat tugadi, bot **hali ishlaydi**, 3 kun muhlat |
| `expired` | Bot to'xtadi. Ma'lumot saqlanadi — to'lasa qayta ishlaydi |

Har soatda cron tekshiradi va egasiga Telegram orqali xabar yuboradi: 3 kun qolganda,
muddat tugaganda, bot to'xtaganda. Cron **idempotent** — ikki marta ishlasa ham natija bir xil.

### Cheklovlar qanday majburlanadi

- **Obunachi limiti** — limitga yetganda yangi `/start` qabul qilinmaydi (eskilar ishlayveradi)
- **Broadcast** — kunlik limit tarifdan olinadi (sinovda 3, Pro'da 20)
- **Do'kon boti** — faqat biznes tarifda (`orders: true`)
- **To'lanmagan bot** — restartdan keyin ham ishga tushmaydi

### Tariflar

| code | narx | obunachi | do'kon |
|---|---|---|---|
| `trial` | 0 (7 kun) | 100 | ✅ |
| `std_500` | 15 000 | 500 | ❌ |
| `std_2k` | 39 000 | 2 000 | ❌ |
| `std_5k` | 79 000 | 5 000 | ❌ |
| `std_15k` | 149 000 | 15 000 | ❌ |
| `std_50k` | 299 000 | 50 000 | ❌ |
| `biz_mini` | 99 000 | 1 000 | ✅ |
| `biz_start` | 199 000 | 3 000 | ✅ |
| `biz_pro` | 399 000 | 10 000 | ✅ |

Muddat tanlanadi: **1 oy** · **3 oy (−10%)** · **12 oy (−20%)**. Uzoq muddat naqd pulni oldindan
keltiradi va churn'ni kamaytiradi.

Narxlar `src/billing/plans.ts` da. **Narx o'zgartirilsa eski mijozlar eski narxda qoladi** —
seed narxni qayta yozmaydi.

---

## Adminlar

| | |
|---|---|
| **Asosiy admin** | `.env` dagi `PLATFORM_ADMIN_IDS`. Bot orqali olib bo'lmaydi |
| **Qo'shilgan admin** | `/panel → 👑 Adminlar → ➕`. To'liq huquqli — **o'zi ham yangi admin qo'sha oladi** |

Admin huquqlari: to'lovlarni tasdiqlash, karta o'zgartirish, statistika, barcha botlar ro'yxati,
admin qo'shish/olib tashlash. Har bir amal `AuditLog` ga yoziladi.

Platforma adminlarining **o'z botlari bepul** — obuna ularga tegmaydi.

---

## Arxitektura

```
src/
├── index.ts              bootstrap: platforma boti + barcha tenant botlar
├── config.ts             .env validatsiyasi (zod)
├── platform/
│   ├── bot.ts            bot yaratish sehrgari, "mening botlarim"
│   ├── payments.ts       karta to'lovi + admin tasdiqlash
│   ├── adminpanel.ts     /panel — to'lovlar, adminlar, karta, statistika
│   ├── access.ts         admin huquqlari, audit
│   └── settings.ts       karta raqami kabi sozlamalar (DB'da)
├── billing/
│   ├── plans.ts          tariflar katalogi
│   ├── subscription.ts   obuna hayot sikli
│   └── cron.ts           soatlik tekshiruv + ogohlantirish
├── runtime/
│   ├── registry.ts       tenant botlarni ishga tushirish/to'xtatish
│   ├── admin.ts          har bir botdagi umumiy admin panel
│   └── context.ts        BotTemplate kontrakti
├── templates/            kino, shop, broadcast, booking, support,
│                         contest, faq, survey
├── jobs/broadcast.ts     rate-limit bilan ommaviy yuborish
└── lib/                  crypto, state, telegram helperlari
```

**Qanday ishlaydi:** bitta Node jarayoni platforma botini va barcha tenant botlarni
long polling orqali yuritadi. Har bir bot o'z grammY instance'iga ega, `registry.ts`
ularni `Map` da saqlaydi. Sozlama o'zgarsa `reloadBot()` chaqiriladi — **restart kerak emas**.

---

## Xavfsizlik

- Bot tokenlari **AES-256-GCM** bilan shifrlanadi (`ENCRYPTION_KEY`), faqat Telegram'ga
  murojaat paytida xotirada ochiladi
- Token yuborilgan xabar chatdan **darhol o'chiriladi**
- Log'da token ko'rinsa avtomatik `<token:redacted>` bilan almashtiriladi
- `sha256(token)` bilan bitta token ikki marta ro'yxatdan o'tmaydi
- Har bir DB so'rovi `ownerId`/`botId` bo'yicha filtrlangan — `npm run check` buni tekshiradi
- Owner o'chirilsa uning botlari va ularning ma'lumotlari cascade bilan o'chadi

---

## Telegram cheklovlari (kodda hisobga olingan)

- `file_id` **botga xos** — bir bot yuklagan faylni boshqasi ishlata olmaydi
- 429 → `retry_after` hurmat qilinadi, eksponensial backoff (5 urinish)
- 403 (foydalanuvchi bloklagan) → `status = blocked_by_user`, qayta urinilmaydi
- Broadcast tezligi `BROADCAST_RATE_PER_SEC` (default 20, Telegram tomi ~30)
- `answerCallbackQuery` har doim chaqiriladi

---

## Serverga qo'yish

```bash
git clone <repo> && cd botplatform
npm install && npm run db:push
# .env ni to'ldiring
npx pm2 start "npm start" --name botplatform
npx pm2 save && npx pm2 startup
```

Baza — bitta fayl: `data/app.db`. Zaxira nusxa:

```bash
cp data/app.db backups/app-$(date +%F).db
```

### Postgres'ga o'tish

Yuklama oshganda: `prisma/schema.prisma` da `provider = "postgresql"`,
`DATABASE_URL` ni o'zgartiring, `npx prisma migrate dev`. **Ilova kodi o'zgarmaydi.**

### Webhook'ga o'tish

Long polling minglab botgacha yetadi. Kerak bo'lganda `registry.ts` dagi `bot.start()`
o'rniga `bot.api.setWebhook()` + webhook qabul qiluvchi qo'yiladi — qolgan kod o'zgarmaydi.
