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

| | Shablon | Nima qiladi |
|---|---|---|
| 🎬 | **Kino** | Foydalanuvchi kod yuboradi → kino keladi. Majburiy obuna, ko'rishlar hisobi |
| 🛒 | **Do'kon** | Katalog → savat → buyurtma. Adminga xabar + bir tugmada tasdiqlash |
| 📢 | **Reklama** | Obunachilar yig'adi, hammasiga bir tugmada xabar yuboradi |
| 📋 | **Anketa** | Bosqichma-bosqich savollar, javoblarni CSV qilib yuklab olish |

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

## Arxitektura

```
src/
├── index.ts              bootstrap: platforma boti + barcha tenant botlar
├── config.ts             .env validatsiyasi (zod)
├── platform/bot.ts       bot yaratish sehrgari, "mening botlarim"
├── runtime/
│   ├── registry.ts       tenant botlarni ishga tushirish/to'xtatish
│   ├── admin.ts          har bir botdagi umumiy admin panel
│   └── context.ts        BotTemplate kontrakti
├── templates/            kino, shop, broadcast, survey
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
