const tg = window.Telegram?.WebApp;
tg?.ready(); tg?.expand();

const app = document.getElementById('app');
const uzs = n => (n ?? 0).toLocaleString('ru-RU').replace(/,/g,' ') + " so'm";
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

const KIND = {topup:'💰 To’ldirish', subscription:'📦 Obuna', template:'🧩 Shablon',
              refund:'↩️ Qaytarish', bonus:'🎁 Bonus'};
const TPL = {kino:'🎬 Kino', shop:'🛒 Do’kon', broadcast:'📢 Reklama', booking:'📅 Navbat',
             support:'💬 Aloqa', contest:'🎁 Konkurs', faq:'🤖 Savol-javob', survey:'📋 Anketa'};
const PLAN_STATUS = {trial:['🎁 Sinov','warn'], active:['✅ Faol','ok'], grace:['⚠️ Muddat tugadi','warn'],
                     expired:['⛔️ To’lov kerak','bad'], unpaid:['⛔️ To’lov kerak','bad'],
                     staff:['👑 Platforma','ok']};

async function api(path, extra = {}) {
  const r = await fetch(path, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({initData: tg?.initData ?? '', ...extra}),
  });
  return r.json();
}

function fail(msg) {
  app.innerHTML = `<div class="empty"><div style="font-size:40px">😕</div>
    <p>${esc(msg)}</p><p class="muted">Botni qaytadan oching.</p></div>`;
}

// A bot id in the launch parameter means "show this bot", otherwise the wallet view.
const startParam = tg?.initDataUnsafe?.start_param || new URLSearchParams(location.search).get('bot');

async function renderOwner() {
  const res = await api('/api/me');
  if (!res.ok) return fail(res.error === 'owner' ? 'Avval botga /start bosing' : 'Ma’lumot olinmadi');
  const d = res.data;

  const bots = d.bots.length ? d.bots.map(b => {
    const [label, cls] = PLAN_STATUS[b.planStatus] ?? ['—','warn'];
    const cap = b.maxUsers && b.maxUsers < 1e9
      ? `${b.users}/${b.maxUsers}` : `${b.users}`;
    return `<div class="card" data-bot="${b.id}" style="cursor:pointer">
      <div class="row"><b>@${esc(b.username)}</b><span class="pill ${cls}">${label}</span></div>
      <div class="row"><span class="muted">${TPL[b.template] ?? b.template}</span>
        <span class="muted">👥 ${cap}${b.today ? ` · bugun +${b.today}` : ''}</span></div>
      ${b.daysLeft != null ? `<div class="muted" style="margin-top:6px;font-size:13px">${b.daysLeft} kun qoldi</div>` : ''}
    </div>`;
  }).join('') : `<div class="empty">Hali bot yo’q.<br><span class="muted">Botda «➕ Bot yaratish» bosing.</span></div>`;

  const txs = d.txs.length ? d.txs.map(t => `<div class="row">
      <span>${KIND[t.kind] ?? t.kind}<br><span class="muted" style="font-size:12px">${esc(t.note ?? '')}</span></span>
      <b style="color:${t.amount > 0 ? '#4cc97c' : 'inherit'}">${t.amount > 0 ? '+' : '−'}${uzs(Math.abs(t.amount))}</b>
    </div>`).join('') : '<p class="muted">Hali amallar yo’q.</p>';

  app.innerHTML = `
    <h1>Salom, ${esc(d.name)}${d.isPremium ? ' 💎' : ''}</h1>
    <div class="balance"><span>Balans</span><b>${uzs(d.balance)}</b></div>
    <button id="topup">➕ Balansni to’ldirish</button>
    <h2>Botlarim (${d.bots.length})</h2>${bots}
    <h2>Amallar tarixi</h2><div class="card">${txs}</div>`;
}

async function renderBot(botId) {
  const res = await api('/api/bot', {botId});
  if (!res.ok) return fail(res.error === 'forbidden' ? 'Bu bot sizniki emas' : 'Ma’lumot olinmadi');
  const d = res.data;
  const s = d.stats;

  const max = Math.max(1, ...d.chart.map(c => c.count));
  const bars = d.chart.map(c =>
    `<i style="height:${Math.round(c.count / max * 100)}%" title="${c.date}: ${c.count}"></i>`).join('');

  const cards = [
    ['👥', s.users, 'Obunachilar'],
    ['🆕', s.todayUsers, 'Bugun'],
    ['🚫', s.blocked, 'Bloklagan'],
    ['💎', s.subs, 'Obunachi (pullik)'],
  ];
  if (d.template === 'kino') cards.push(['🎬', s.movies, 'Kinolar']);
  if (d.template === 'shop') cards.push(['📦', s.products, 'Mahsulotlar']);
  if (d.template === 'support') cards.push(['💬', s.tickets, 'Ochiq murojaat']);
  if (d.template === 'booking') cards.push(['📅', s.bookings, 'Kelgusi navbat']);

  const orders = d.orders.length ? d.orders.map(o => `<div class="row">
      <span>#${o.number} · ${esc(o.status)}<br>
        <span class="muted" style="font-size:12px">${esc(o.address || o.phone)}</span></span>
      <b>${uzs(o.total)}</b></div>`).join('')
    : '<p class="muted">Buyurtma yo’q.</p>';

  app.innerHTML = `
    <button id="back" class="tab" style="margin-bottom:12px">◀️ Botlarim</button>
    <h1>@${esc(d.username)}</h1>
    <p class="muted" style="margin-top:-8px">${TPL[d.template] ?? d.template} ·
      ${d.status === 'active' ? '🟢 ishlayapti' : '⚪️ to’xtatilgan'}</p>
    <h2>14 kunlik o’sish</h2>
    <div class="card"><div class="bar">${bars}</div></div>
    <h2>Ko’rsatkichlar</h2>
    <div class="grid">${cards.map(([i, v, l]) =>
      `<div class="stat"><b>${i} ${v}</b><span>${l}</span></div>`).join('')}</div>
    ${d.template === 'shop' ? `<h2>Oxirgi buyurtmalar</h2><div class="card">${orders}</div>` : ''}`;
}

// Delegated: CSP blocks inline onclick, and the markup is re-rendered often.
app.addEventListener('click', e => {
  const card = e.target.closest('[data-bot]');
  if (card) { tg?.HapticFeedback?.impactOccurred('light'); renderBot(card.dataset.bot); return; }
  if (e.target.closest('#topup')) tg?.close();
  if (e.target.closest('#back')) renderOwner();
});

(startParam && startParam !== 'wallet' ? renderBot(startParam) : renderOwner())
  .catch(e => fail('Xatolik: ' + e.message));
