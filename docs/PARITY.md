# Funksional parity xaritasi — @SafoBuilderBot

> Maqsad: **funksional 1:1 takrorlash**. Nusxa ko'chirilmaydigan narsalar (prompt §0.9 va §19 bo'yicha): matnlar, dizayn, logotip, brend nomi, kod.
> Holat: **to'ldirilmagan** — ma'lumot yig'ilishi kerak (§0 ga qarang).

---

## 0. Nima uchun bu hujjat bo'sh

Men Telegram'ga kira olmayman — @SafoBuilderBot bilan yozisha olmayman, tugmalarini bosa olmayman.
`safobuilder.com` esa avtomatik so'rovlarni bloklaydi (HTTP 403).

Ya'ni oqimlarni **siz olib berishingiz** kerak. Eng tez usul — quyidagi ro'yxat bo'yicha ekran rasmlari (yoki ekran yozuvi), yoki bot xabarlarini matn holida nusxalab tashlash.

---

## 1. Ochiq manbalardan ma'lum bo'lgani

| Ma'lumot | Manba |
|---|---|
| 6 tur bot: **kino, do'kon, chatbot, reklama (broadcast), konkurs, so'rovnoma** | safobuilder.com |
| Bot 5 daqiqada tayyor: **token + admin ID** kiritiladi, qolganini platforma qiladi | safobuilder.com |
| 18 000+ foydalanuvchi; "O'zbekistondagi birinchi avtomatik bot yaratish platformasi" | safobuilder.com/about |
| Ro'yxatdan o'tish 30 soniya, karta talab qilinmaydi | safobuilder.com |
| Token **shifrlangan** holda saqlanadi, 99.9% uptime va'dasi | safobuilder.com |
| Panel: foydalanuvchilarni ko'rish, bloklash, real vaqt statistika, kunlik hisobot | safobuilder.com |
| Kino bot: kino/serial/anime kutubxonasi, qidiruv, yuklab olish | safobuilder.com |
| Rejada: sayt yaratish, to'lov tizimlari, marketing vositalari | safobuilder.com |
| Boshqa tilga olingan turlar: admin bot, ro'yxatdan o'tish boti, eslatma boti, referal bot | safobuilder.com/about |

**Bizning rejamiz bilan farq:** rejada MVP = Broadcast, Kino, Do'kon, Anketa; Konkurs va Aloqa (chatbot) Phase 7 da.
SafoBuilder'da **Konkurs va Chatbot asosiy 6 talik ichida**. Parity maqsad bo'lsa — ular Phase 4 ga ko'chirilishi kerak (§4 ga qarang).

---

## 2. Kerak bo'lgan ma'lumot — to'ldirish ro'yxati

Har bir band uchun: **ekran rasmi + tugma matnlari + bot javoblari**.

### 2.1 Platforma boti (@SafoBuilderBot) — onboarding
- [ ] `/start` bosilganda nima chiqadi (matn + tugmalar)
- [ ] Ro'yxatdan o'tish oqimi: telefon? email? Telegram login? Nechta qadam?
- [ ] Bot yaratish oqimi qadamma-qadam: token so'raladimi bot ichida yoki saytda? Admin ID qanday olinadi?
- [ ] Token noto'g'ri kiritilsa qanday xato chiqadi
- [ ] Bot yaratilgandan keyin nima ko'rsatiladi
- [ ] Bot ichida admin menyu bormi — qanday bo'limlar

### 2.2 Panel (web yoki bot ichida?)
- [ ] Panel qayerda — web sayt (`safobuilder.com/...`) yoki hammasi bot ichidami?
- [ ] Asosiy sahifada qanday raqamlar/grafiklar bor
- [ ] Bot sozlamalari sahifasi: qanday maydonlar bor (har bir shablon uchun alohida)
- [ ] Foydalanuvchilar ro'yxati: qanday ustunlar, qanday amallar (bloklash, eksport?)
- [ ] Statistika: qanday davr (kun/hafta/oy), qanday ko'rsatkichlar

### 2.3 Tariflar — **eng muhim qism**
- [ ] Tariflar ro'yxati: nom, narx (UZS), foydalanuvchi limiti, qaysi imkoniyatlar
- [ ] Trial bormi, necha kun, qanday cheklov bilan
- [ ] To'lov usullari: Click / Payme / boshqa
- [ ] Limit tugaganda nima bo'ladi (bot to'xtaydimi, ogohlantirishmi)
- [ ] Bir nechta bot uchun narx qanday hisoblanadi

> Bu bizning §3.1 dagi taxminiy narxlarni almashtiradi yoki tasdiqlaydi.

### 2.4 Shablonlar — har biri uchun alohida
Har bir shablonda: **oxirgi foydalanuvchi ko'radigan oqim** + **admin sozlamalari**.

- [ ] **Kino:** majburiy obuna qanday ishlaydi, kod bo'yicha qidiruv, nom bo'yicha qidiruv, kino qo'shish oqimi, avtomatik o'chirish bormi
- [ ] **Do'kon:** katalog ko'rinishi, savat, buyurtma qadamlari, to'lov, admin xabari va tugmalari
- [ ] **Broadcast/Reklama:** xabar turlari, rejalashtirish, tugma qo'shish, progress ko'rsatkichi
- [ ] **So'rovnoma:** savol turlari, natijalar qayerda ko'rinadi, eksport formati
- [ ] **Konkurs:** shartlar, g'olib tanlash, e'lon qilish
- [ ] **Chatbot:** aynan nima qiladi — savol-javob? operatorga ulash? avtomatik javoblar?

### 2.5 Chegaralar (raqobat ustunligi uchun)
- [ ] Nima ishlamaydi / sekin / noqulay
- [ ] Foydalanuvchilar nimadan shikoyat qiladi
- [ ] Qaysi imkoniyat yo'q, lekin kerak

---

## 3. Nusxa ko'chirilmaydigan narsalar (prompt §0.9, §19)

| Takrorlanadi | Takrorlanmaydi |
|---|---|
| Shablon turlari va ularning funksiyalari | Bot va panel matnlari — o'zimiznikini yozamiz |
| Oqim mantiqi (nechta qadam, qanday tartibda) | Dizayn, ranglar, logotip |
| Tarif tuzilishi (limit turlari) | Brend nomi ("Safo…" nomi ishlatilmaydi) |
| Panel bo'limlari va ko'rsatkichlar | Kod (bizda hech qanday kodi yo'q — TypeScript'da noldan yoziladi) |

Domen `safo.niskandarov.uz` — `safobuilder.com` bilan nom yaqinligi bor. Brend nomi tanlashda buni hisobga oling.

---

## 4. Parity uchun rejaga taklif qilinadigan o'zgarish

Agar maqsad "6 talik shablon to'plami bir xil bo'lsin" bo'lsa:

| Shablon | Hozirgi reja | Parity uchun |
|---|---|---|
| Broadcast | Phase 3 | Phase 3 ✅ |
| Kino | Phase 4 | Phase 4 ✅ |
| Do'kon | Phase 4 | Phase 4 ✅ |
| Anketa/So'rovnoma | Phase 4 | Phase 4 ✅ |
| **Konkurs** | Phase 7 | **Phase 4** ga ko'chirilsin |
| **Chatbot/Aloqa** | Phase 7 | **Phase 4** ga ko'chirilsin |

Bu Phase 4 ni ~2 barobar kattalashtiradi. Alternativa: Phase 4 ni "4a (kino+do'kon)" va "4b (anketa+konkurs+chatbot)" ga bo'lish.

**Qaror kerak** — §2.4 ma'lumotlari kelgach aniqlashtiriladi.
