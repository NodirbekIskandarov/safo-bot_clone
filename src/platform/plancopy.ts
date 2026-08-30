/**
 * Sales copy for the tariff screens. Prices and limits live in the database;
 * this is only the "who is it for" layer users actually decide on.
 */
export interface PlanCopy {
  audience: string; // one line: who should pick this
  example: string;  // a concrete situation the reader recognises
}

export const PLAN_COPY: Record<string, PlanCopy> = {
  trial: {
    audience: "Sinab ko'rish uchun",
    example: "Botni yig'ib, ishlashini ko'rasiz. Karta so'ralmaydi.",
  },
  std_500: {
    audience: "Yangi kanal, kichik auditoriya",
    example: "Endi boshlagan kino kanali yoki mahalliy e'lonlar boti.",
  },
  std_2k: {
    audience: "O'sib borayotgan kanal",
    example: "Bir necha oydan beri ishlayotgan, kuniga 10-20 ta yangi obunachi keladi.",
  },
  std_5k: {
    audience: "Barqaror, faol auditoriya",
    example: "Kunlik reklama yuboradigan, obunachilari doimiy o'sadigan kanal.",
  },
  std_15k: {
    audience: "Katta kanal",
    example: "Reklama sotadigan, kuniga bir necha marta post qiladigan loyiha.",
  },
  std_50k: {
    audience: "Yirik loyiha",
    example: "Bir nechta kanal tarmog'i, kuniga 50 tagacha yuborish.",
  },
  biz_mini: {
    audience: "Kichik do'kon, birinchi qadam",
    example: "Instagram'dan sotadigan, kuniga 5-10 buyurtma oladigan do'kon.",
  },
  biz_start: {
    audience: "Ishlab turgan do'kon yoki kafe",
    example: "Doimiy mijozlari bor, kuniga 20-50 buyurtma.",
  },
  biz_pro: {
    audience: "Katta do'kon, bir nechta xodim",
    example: "Kuniga 100+ buyurtma, ombor va yetkazib berish xizmati bor.",
  },
};

/** Cheapest plan that covers the expected audience and the orders requirement. */
export function recommend<T extends { maxBotUsers: number; priceUzs: number; features: string }>(
  plans: T[],
  expectedUsers: number,
  needsOrders: boolean,
): T | undefined {
  return plans
    .filter((p) => {
      const f = JSON.parse(p.features) as { orders: boolean };
      return (!needsOrders || f.orders) && p.maxBotUsers >= expectedUsers;
    })
    .sort((a, b) => a.priceUzs - b.priceUzs)[0];
}

/** UZS per subscriber per month — the number that makes the ladder make sense. */
export function perUser(priceUzs: number, maxBotUsers: number): string {
  const value = priceUzs / maxBotUsers;
  return value >= 10 ? `${Math.round(value)} so'm` : `${value.toFixed(1)} so'm`;
}
