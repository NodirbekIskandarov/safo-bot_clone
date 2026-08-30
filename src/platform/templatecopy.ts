/**
 * What each template actually does, in the words of someone deciding whether
 * to build it. Kept out of the template modules so those stay about behaviour.
 */
export interface TemplateCopy {
  useCases: string;   // who builds this
  userFlow: string[]; // what the end customer experiences, in order
  adminTools: string[]; // what the owner can do from inside their own bot
  needsBusinessPlan?: boolean;
  note?: string;      // a limitation worth knowing before starting
}

export const TEMPLATE_COPY: Record<string, TemplateCopy> = {
  kino: {
    useCases: "Kino kanallari, serial va anime kanallari, kurs/darslik tarqatuvchilar",
    userFlow: [
      "Botga /start bosadi",
      "Majburiy obuna qo'ygan bo'lsangiz — kanallaringizga obuna bo'ladi",
      "Kino kodini yozadi (masalan 100)",
      "Kino darhol yuboriladi",
    ],
    adminTools: [
      "Video tashlab kod va nom berish — kino qo'shiladi",
      "Majburiy obuna kanallarini qo'shish/olib tashlash",
      "Qaysi kino necha marta ko'rilganini ko'rish",
      "Barcha obunachilarga xabar yuborish",
    ],
    note: "Video faqat shu bot orqali yuklanadi — Telegram fayllarni botga bog'laydi, boshqa botga ko'chirib bo'lmaydi.",
  },
  shop: {
    useCases: "Onlayn do'kon, kafe, gullar, shirinliklar, kiyim — buyurtma qabul qiladigan har qanday savdo",
    userFlow: [
      "Katalogni ochadi, bo'lim tanlaydi",
      "Mahsulotni ko'radi (rasm, narx, tavsif) va savatga qo'shadi",
      "Miqdorni + / − bilan o'zgartiradi",
      "Telefon raqamini yuboradi, yetkazib berish yoki olib ketishni tanlaydi",
      "Buyurtma raqamini oladi",
    ],
    adminTools: [
      "Mahsulot qo'shish: nom → narx → rasm",
      "Bo'limlar yaratish",
      "Yangi buyurtma xabari + «Tasdiqlash / Bekor / Yetkazildi» tugmalari",
      "Har bir holat o'zgarishida mijozga avtomatik xabar boradi",
    ],
    needsBusinessPlan: true,
    note: "To'lov hozircha naqd. Click/Payme ulanishi keyingi bosqichda.",
  },
  broadcast: {
    useCases: "E'lon kanallari, kurslar, do'konlar — obunachi bazasi yig'ish va ularga xabar yuborish",
    userFlow: [
      "Botga /start bosadi va obunachiga aylanadi",
      "Siz yuborgan xabarlarni oladi",
      "Xohlasa /stop bilan obunani bekor qiladi",
    ],
    adminTools: [
      "Istalgan xabarni tashlash — matn, rasm, video, fayl, ovozli xabar",
      "Yuborishdan oldin nechta odamga ketishini ko'rish va tasdiqlash",
      "Jonli progress: 120/400",
      "Yakuniy hisobot: yetkazildi / bloklagan / xato",
    ],
  },
  booking: {
    useCases: "Sartaroshxona, go'zallik saloni, klinika, avtoyuvish, ustaxona, repetitor",
    userFlow: [
      "«Navbat olish» tugmasini bosadi",
      "Xizmat turini tanlaydi",
      "Kunni tanlaydi (7 kun oldinga)",
      "Bo'sh soatni tanlaydi — band vaqtlar umuman ko'rsatilmaydi",
      "Telefon raqamini qoldiradi va navbat raqamini oladi",
    ],
    adminTools: [
      "Xizmatlar ro'yxatini o'zgartirish",
      "Bugungi navbatlarni soat bo'yicha ko'rish",
      "«Tasdiqlash / Bekor» tugmasi — mijozga avtomatik xabar boradi",
    ],
    note: "Ish vaqti 09:00–18:00, har soatda bitta navbat. O'zgartirish kerak bo'lsa ayting.",
  },
  support: {
    useCases: "Har qanday biznes: mijozlar savoli, shikoyat, buyurtma holati",
    userFlow: [
      "Savolini botga yozadi (matn, rasm, fayl — farqi yo'q)",
      "Murojaat raqamini oladi: #14",
      "Javobingizni o'sha botda ko'radi",
    ],
    adminTools: [
      "Har bir murojaat sizga darhol keladi",
      "«Javob berish» tugmasi — yozganingiz mijozga yetadi",
      "«Yopish» tugmasi",
      "Ochiq murojaatlar ro'yxati",
    ],
    note: "Mijoz sizning shaxsiy raqamingizni ko'rmaydi — hamma narsa bot orqali.",
  },
  contest: {
    useCases: "Kanal o'stirish, mahsulot reklamasi, ochilish tadbirlari",
    userFlow: [
      "«Ishtirok etish» tugmasini bosadi",
      "Kanallaringizga obuna bo'ladi (talab qilsangiz)",
      "Bilet raqamini oladi: #47",
      "Natijani o'sha botda ko'radi",
    ],
    adminTools: [
      "Konkurs yaratish: nom → sovrin → nechta g'olib",
      "Ishtirokchilar sonini kuzatish",
      "«G'olibni aniqlash» — tasodifiy tanlanadi",
      "Natija barcha ishtirokchilarga avtomatik yuboriladi",
    ],
    note: "G'olib crypto.randomInt bilan tanlanadi — natija tekshirilishi mumkin, hech kim ta'sir o'tkaza olmaydi.",
  },
  faq: {
    useCases: "Kurslar, klinikalar, do'konlar — bir xil savol kuniga o'nlab marta kelsa",
    userFlow: [
      "Savolini o'z so'zlari bilan yozadi",
      "Bot kalit so'zlar bo'yicha mos javobni topib beradi",
      "Topolmasa — tayyor savollar ro'yxatini ko'rsatadi",
    ],
    adminTools: [
      "Savol va javob qo'shish",
      "Qaysi savol necha marta so'ralganini ko'rish",
      "Kam so'raladiganini o'chirish",
    ],
    note: "Sun'iy intellekt emas — kalit so'z bo'yicha ishlaydi. Savolni turli so'zlar bilan yozib qo'ysangiz aniqroq topadi.",
  },
  survey: {
    useCases: "So'rovnoma, ariza qabul qilish, ro'yxatga olish, fikr yig'ish",
    userFlow: [
      "Savollarga birma-bir javob beradi",
      "Telefon raqamini tugma bilan yuboradi",
      "Oxirida tasdiq oladi",
    ],
    adminTools: [
      "Savollarni birma-bir qo'shish",
      "Barcha javoblarni CSV fayl qilib yuklab olish — Excel'da ochiladi",
      "Nechta odam to'ldirganini ko'rish",
    ],
  },
};
