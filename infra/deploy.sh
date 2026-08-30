#!/usr/bin/env bash
# Pull the latest code and restart. Safe to run repeatedly.
set -euo pipefail

APP_DIR=/opt/botxona
cd "$APP_DIR"

echo "→ Zaxira nusxa"
mkdir -p backups
cp data/app.db "backups/app-$(date +%F-%H%M).db" 2>/dev/null || true
# keep two weeks of daily copies, drop the rest
ls -1t backups/app-*.db 2>/dev/null | tail -n +15 | xargs -r rm --

echo "→ Kod yangilanmoqda"
git pull --ff-only

echo "→ Paketlar"
npm install --no-audit --no-fund

echo "→ Baza"
npx prisma generate
npx prisma db push --skip-generate --accept-data-loss

echo "→ Qayta ishga tushirish"
systemctl restart botxona
sleep 4
systemctl is-active --quiet botxona && echo "✅ Ishlayapti" || {
  echo "❌ Ishga tushmadi — oxirgi loglar:"
  tail -30 /var/log/botxona.log
  exit 1
}
tail -5 /var/log/botxona.log
