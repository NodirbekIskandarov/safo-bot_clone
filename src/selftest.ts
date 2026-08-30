/**
 * Runs without a Telegram token: verifies the pieces that must not silently
 * break — encryption round-trip, token fingerprinting, DB reachability and
 * that every template is registered exactly once.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { fingerprint, open, seal } from "./lib/crypto.js";
import { templateList, templates } from "./templates/index.js";
import { payablePlans, seedPlans } from "./billing/plans.js";
import { accessFor, activate, billingTick, openSubscription } from "./billing/subscription.js";
import { TERMS, termPrice } from "./platform/menu.js";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✅" : "  ❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const fakeToken = `123456789:${randomBytes(20).toString("base64url")}`;

console.log("\n🔐 Shifrlash");
const sealed = seal(fakeToken);
check("encrypt → decrypt bir xil qiymat qaytaradi", open(sealed) === fakeToken);
check("shifrmatn ochiq matnga o'xshamaydi", !Buffer.from(sealed.cipher).toString("utf8").includes(fakeToken));
check("har safar yangi IV", Buffer.compare(Buffer.from(seal(fakeToken).iv), Buffer.from(sealed.iv)) !== 0);
check("fingerprint deterministik", fingerprint(fakeToken) === fingerprint(fakeToken));
check("boshqa token → boshqa fingerprint", fingerprint(fakeToken) !== fingerprint(fakeToken + "x"));

let tampered = false;
try {
  const bad = Buffer.from(sealed.cipher);
  bad[0] = (bad[0]! ^ 0xff) & 0xff;
  open({ ...sealed, cipher: bad });
} catch {
  tampered = true;
}
check("buzilgan shifrmatn rad etiladi (GCM auth)", tampered);

console.log("\n🧩 Shablonlar");
check("4 ta shablon ro'yxatda", templateList.length === 4, `topildi: ${templateList.length}`);
for (const t of templateList) {
  check(`${t.emoji} ${t.name} (${t.key})`, templates[t.key] === t);
}
check("kalitlar takrorlanmaydi", new Set(templateList.map((t) => t.key)).size === templateList.length);

console.log("\n🗄 Ma'lumotlar bazasi");
try {
  const counts = {
    owners: await db.owner.count(),
    bots: await db.bot.count(),
    users: await db.botUser.count(),
  };
  check("bazaga ulanish", true, `owner:${counts.owners} bot:${counts.bots} user:${counts.users}`);

  const owner = await db.owner.create({
    data: { tgUserId: BigInt(Date.now()), fullName: "selftest" },
  });
  const other = await db.owner.create({
    data: { tgUserId: BigInt(Date.now() + 1), fullName: "selftest-2" },
  });
  const bot = await db.bot.create({
    data: {
      ownerId: owner.id,
      templateKey: "kino",
      title: "t",
      tgBotId: BigInt(1),
      tgUsername: "t",
      tokenCipher: Buffer.from(sealed.cipher),
      tokenIv: Buffer.from(sealed.iv),
      tokenTag: Buffer.from(sealed.tag),
      tokenHash: fingerprint(fakeToken),
      settings: "{}",
    },
  });

  const leak = await db.bot.findFirst({ where: { id: bot.id, ownerId: other.id } });
  check("tenant izolyatsiyasi: begona owner botni ko'rmaydi", leak === null);

  let duplicateRejected = false;
  try {
    await db.bot.create({
      data: {
        ownerId: other.id,
        templateKey: "kino",
        title: "t2",
        tgBotId: BigInt(2),
        tgUsername: "t2",
        tokenCipher: Buffer.from(sealed.cipher),
        tokenIv: Buffer.from(sealed.iv),
        tokenTag: Buffer.from(sealed.tag),
        tokenHash: fingerprint(fakeToken),
        settings: "{}",
      },
    });
  } catch {
    duplicateRejected = true;
  }
  check("bitta token ikki marta ro'yxatdan o'tmaydi", duplicateRejected);

  await db.botUser.create({ data: { botId: bot.id, tgUserId: BigInt(999), firstName: "u" } });
  await db.owner.delete({ where: { id: owner.id } });
  const orphans = await db.botUser.count({ where: { botId: bot.id } });
  check("owner o'chsa bot va foydalanuvchilari ham o'chadi (cascade)", orphans === 0);

  await db.owner.delete({ where: { id: other.id } }).catch(() => {});
} catch (err) {
  check("bazaga ulanish", false, String(err));
}

console.log("\n💳 Billing");
try {
  await seedPlans();
  const plans = await db.plan.findMany();
  check("8 ta tarif seed qilindi", plans.length === 8, `topildi: ${plans.length}`);
  check("narxlar butun UZS", plans.every((p) => Number.isInteger(p.priceUzs)));

  const shopPlans = await payablePlans("shop");
  const kinoPlans = await payablePlans("kino");
  check("do'kon boti faqat biznes tarifda", shopPlans.every((p) => p.group === "business"), `${shopPlans.length} ta`);
  check("kino boti barcha pullik tarifda", kinoPlans.length === 7, `${kinoPlans.length} ta`);

  const owner = await db.owner.create({ data: { tgUserId: BigInt(Date.now() + 7), fullName: "billing-test" } });
  const mk = async (n: number) =>
    db.bot.create({
      data: {
        ownerId: owner.id, templateKey: "kino", title: `b${n}`, tgBotId: BigInt(1000 + n),
        tgUsername: `b${n}`, tokenCipher: Buffer.from(sealed.cipher), tokenIv: Buffer.from(sealed.iv),
        tokenTag: Buffer.from(sealed.tag), tokenHash: fingerprint(fakeToken + n), settings: "{}",
      },
    });

  const bot1 = await mk(1);
  const first = await openSubscription(bot1.id, owner.id);
  check("birinchi bot sinov muddatini oladi", first.trialGranted && first.subscription.status === "trial");

  const bot2 = await mk(2);
  const second = await openSubscription(bot2.id, owner.id);
  check("ikkinchi bot sinov olmaydi (trial akkauntga bog'liq)", !second.trialGranted && second.subscription.status === "unpaid");

  const paid = await db.plan.findFirstOrThrow({ where: { code: "std_2k" } });
  await activate(second.subscription.id, paid.id);
  const after = await accessFor(bot2.id);
  check("to'lovdan keyin obuna faollashadi", after?.status === "active" && after.live === true);
  check("limit tarifdan olinadi", after?.maxBotUsers === 2000, `${after?.maxBotUsers}`);
  check("muddat ~30 kun", (after?.daysLeft ?? 0) >= 29 && (after?.daysLeft ?? 0) <= 31, `${after?.daysLeft} kun`);

  // paying early must add to the remaining time, not replace it
  const before = (await db.subscription.findUniqueOrThrow({ where: { id: second.subscription.id } })).currentPeriodEnd!;
  await activate(second.subscription.id, paid.id);
  const extended = (await db.subscription.findUniqueOrThrow({ where: { id: second.subscription.id } })).currentPeriodEnd!;
  check("erta to'lasa kunlar qo'shiladi, yo'qolmaydi", extended.getTime() > before.getTime());

  // Telegram rejects any button whose callback_data exceeds 64 bytes, and it
  // fails the whole message — the symptom is "the button does nothing".
  const uuid = "3a3ed9b5-0c6c-4196-b397-58eb6e717028";
  const samples = [
    `p:bot:${uuid}`, `p:pay:${uuid}`, `p:toggle:${uuid}`, `p:delyes:${uuid}`, `p:text:${uuid}`,
    `adm:pay:ok:${uuid}`, `pa:payv:${uuid}`, `sh:ord:confirmed:${uuid}`, `sh:dec:${uuid}`,
    ...plans.map((p) => `py:${uuid}:${p.code}`),
    ...plans.flatMap((p) => TERMS.map((t) => `pyd:${uuid}:${p.code}:${t.months}`)),
  ];
  const oversized = samples.filter((c) => Buffer.byteLength(c) > 64);
  check("barcha tugmalar 64 bayt limitiga sig'adi", oversized.length === 0, oversized[0] ?? `eng uzun: ${Math.max(...samples.map((c) => Buffer.byteLength(c)))} bayt`);

  check("3 oy 10% arzon", termPrice(39_000, 3) === 105_000, `${termPrice(39_000, 3)}`);
  check("12 oy 20% arzon", termPrice(39_000, 12) === 374_000, `${termPrice(39_000, 12)}`);
  check("1 oy chegirmasiz", termPrice(39_000, 1) === 39_000);
  check("summalar 1000 ga yaxlitlangan", TERMS.every((t) => termPrice(15_000, t.months) % 1000 === 0));

  // paying mid-trial must not throw away the unused trial days
  const bot3 = await mk(3);
  const third = await openSubscription(bot3.id, owner.id);
  await db.subscription.update({
    where: { id: third.subscription.id },
    data: { status: "trial", trialEndsAt: new Date(Date.now() + 5 * 24 * 3600 * 1000) },
  });
  await activate(third.subscription.id, paid.id, 1);
  const kept = await accessFor(bot3.id);
  check("sinov ichida to'lasa qolgan kunlar yonmaydi", (kept?.daysLeft ?? 0) >= 34, `${kept?.daysLeft} kun (30 + qolgan 5)`);

  // expire the trial and walk the lifecycle
  await db.subscription.update({
    where: { id: first.subscription.id },
    data: { trialEndsAt: new Date(Date.now() - 1000) },
  });
  const ev1 = await billingTick();
  check("muddati tugagan sinov grace'ga o'tadi", ev1.some((e) => e.botId === bot1.id && e.kind === "grace"));

  const ev1again = await billingTick();
  check("cron idempotent (ikkinchi urinishda takrorlamaydi)", !ev1again.some((e) => e.botId === bot1.id && e.kind === "grace"));

  await db.subscription.update({
    where: { id: first.subscription.id },
    data: { graceEndsAt: new Date(Date.now() - 1000) },
  });
  const ev2 = await billingTick();
  check("grace tugagach bot to'xtatiladi", ev2.some((e) => e.botId === bot1.id && e.kind === "stopped"));

  const dead = await accessFor(bot1.id);
  check("to'xtagan obuna live emas", dead?.live === false && dead.status === "expired");

  await db.owner.delete({ where: { id: owner.id } });
} catch (err) {
  check("billing oqimi", false, String(err));
}

await db.$disconnect();
console.log(failures === 0 ? "\n✅ Hammasi joyida\n" : `\n❌ ${failures} ta tekshiruv yiqildi\n`);
process.exit(failures === 0 ? 0 : 1);
