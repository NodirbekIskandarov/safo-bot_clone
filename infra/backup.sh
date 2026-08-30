#!/usr/bin/env bash
# Daily database snapshot. Add to cron:
#   0 3 * * * /opt/botxona/infra/backup.sh
set -euo pipefail
cd /opt/botxona
mkdir -p backups
# sqlite3 .backup takes a consistent copy even while the app is writing
sqlite3 data/app.db ".backup 'backups/app-$(date +%F).db'"
gzip -f "backups/app-$(date +%F).db"
ls -1t backups/app-*.db.gz | tail -n +15 | xargs -r rm --
echo "backup ok: $(date +%F)"
