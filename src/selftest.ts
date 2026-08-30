/**
 * Runs without a Telegram token: verifies the pieces that must not silently
 * break — encryption round-trip, token fingerprinting, DB reachability and
 * that every template is registered exactly once.
 */
import { randomBytes } from "node:crypto";
import { db } from "./db.js";
import { fingerprint, open, seal } from "./lib/crypto.js";
import { templateList, templates } from "./templates/index.js";

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

await db.$disconnect();
console.log(failures === 0 ? "\n✅ Hammasi joyida\n" : `\n❌ ${failures} ta tekshiruv yiqildi\n`);
process.exit(failures === 0 ? 0 : 1);
