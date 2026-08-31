const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const app = document.getElementById('app');
const tap = (s = 'light') => tg?.HapticFeedback?.impactOccurred(s);

const uzs = n => (n ?? 0).toLocaleString('ru-RU').replace(/,/g, ' ') + " so'm";
const num = n => (n ?? 0).toLocaleString('ru-RU').replace(/,/g, ' ');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const day = d => new Date(d).toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit' });
const time = d => new Date(d).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
// Stagger keeps a long list from arriving as one slab, but must not make the
// last card wait a second — cap the delay.
const delay = i => `animation-delay:${Math.min(i * 45, 400)}ms`;

const TPL = { kino:'🎬 Kino', shop:"🛒 Do'kon", broadcast:'📢 Reklama', booking:'📅 Navbat',
              support:'💬 Aloqa', contest:'🎁 Konkurs', faq:'🤖 Savol-javob', survey:'📋 Anketa' };
const KIND = { topup:"💰 To'ldirish", subscription:'📦 Obuna', template:'🧩 Shablon',
               refund:'↩️ Qaytarish', bonus:'🎁 Bonus' };
const PLAN = { trial:["🎁 Sinov",'warn'], active:['✅ Faol','ok'], grace:['⚠️ Muddati tugadi','warn'],
               expired:["⛔️ To'lov kerak",'bad'], unpaid:["⛔️ To'lov kerak",'bad'],
               staff:['👑 Platforma','ok'] };
const ORDER = { new:['🆕 Yangi','warn'], confirmed:['✅ Tasdiqlangan','ok'], delivering:["🚚 Yo'lda",'warn'],
                done:['📦 Yetkazilgan','ok'], canceled:['❌ Bekor','bad'] };
const BOOK = { new:['⏳ Kutilmoqda','warn'], confirmed:['✅ Tasdiqlangan','ok'],
               done:['📦 Bo‘ldi','ok'], canceled:['❌ Bekor','bad'] };
const TICKET = { open:['🔴 Kutilmoqda','bad'], answered:['🟢 Javob berilgan','ok'], closed:['⚪️ Yopilgan','dim'] };

async function api(path, extra = {}) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ initData: tg?.initData ?? '', ...extra }),
  });
  return r.json();
}

function fail(msg, hint) {
  app.innerHTML = `<div class="empty"><div>😕</div><p>${esc(msg)}</p>
    ${hint ? `<p class="sm">${esc(hint)}</p>` : ''}</div>`;
}

/** Count numbers up so a dashboard feels alive rather than pasted in. */
function countUp() {
  for (const el of app.querySelectorAll('[data-count]')) {
    const end = Number(el.dataset.count);
    if (!end || end > 100000) { el.textContent = num(end); continue; }
    const started = performance.now();
    const step = now => {
      const t = Math.min((now - started) / 550, 1);
      el.textContent = num(Math.round(end * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

function chart(points) {
  const max = Math.max(1, ...points.map(p => p.count));
  const bars = points.map((p, i) =>
    `<i style="height:${Math.max(3, Math.round(p.count / max * 100))}%;animation-delay:${i * 35}ms"
        title="${p.date}: ${p.count}"></i>`).join('');
  return `<div class="card anim"><div class="row sm muted"><span>14 kunlik o'sish</span>
      <span>eng ko'p: ${max}</span></div>
    <div class="bar">${bars}</div>
    <div class="bar-x sm muted"><span>${day(points[0].date)}</span>
      <span>${day(points[points.length - 1].date)}</span></div></div>`;
}

/** Usage ring: the plan limit is the number an owner acts on. */
function ring(used, max) {
  if (!max || max > 1e9) return '';
  const pct = Math.min(used / max, 1);
  const R = 42, C = 2 * Math.PI * R;
  const colour = pct > .9 ? 'var(--bad)' : pct > .7 ? 'var(--warn)' : 'var(--ok)';
  return `<div class="card anim" style="text-align:center">
    <svg class="ring" width="112" height="112" viewBox="0 0 100 100" style="--circ:${C}">
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="8"/>
      <circle cx="50" cy="50" r="${R}" fill="none" stroke="${colour}" stroke-width="8"
        stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"
        transform="rotate(-90 50 50)"/>
      <text x="50" y="46" text-anchor="middle" fill="var(--text)" font-size="19"
        font-weight="700">${Math.round(pct * 100)}%</text>
      <text x="50" y="63" text-anchor="middle" fill="var(--hint)" font-size="9">limit</text>
    </svg>
    <div class="sm muted" style="margin-top:6px">${num(used)} / ${num(max)} obunachi</div>
    ${pct > .8 ? `<div class="pill warn" style="display:inline-block;margin-top:8px">
      Limitga yaqinlashdingiz — tarifni oshiring</div>` : ''}
  </div>`;
}

const stat = (icon, value, label, i = 0) =>
  `<div class="stat anim" style="${delay(i)}"><b>${icon} <span data-count="${value}">0</span></b>
    <span>${label}</span></div>`;

function foldable(id, title, rows) {
  if (!rows.length) return '';
  return `<h2>${title}</h2>
    <div class="card anim">
      <div class="row tap" data-fold="${id}"><b>${rows.length} ta</b>
        <span class="chev" id="chev-${id}">›</span></div>
      <div class="list" id="fold-${id}">${rows.join('')}</div>
    </div>`;
}

// ------------------------------------------------------------------ owner

async function renderOwner() {
  const res = await api('/api/me');
  if (!res.ok) return fail(res.error === 'owner' ? "Avval botga /start bosing" : "Ma'lumot olinmadi");
  const d = res.data;

  const bots = d.bots.length ? d.bots.map((b, i) => {
    const [label, cls] = PLAN[b.planStatus] ?? ['—', 'dim'];
    const cap = b.maxUsers && b.maxUsers < 1e9 ? `${num(b.users)}/${num(b.maxUsers)}` : num(b.users);
    return `<div class="card tap anim" data-bot="${b.id}" style="${delay(i)}">
      <div class="row"><b>@${esc(b.username)}</b><span class="pill ${cls}">${label}</span></div>
      <div class="row sm muted"><span>${TPL[b.template] ?? b.template}</span>
        <span>👥 ${cap}${b.today ? ` · bugun +${b.today}` : ''}</span></div>
      ${b.daysLeft != null ? `<div class="sm muted" style="margin-top:6px">⏳ ${b.daysLeft} kun qoldi</div>` : ''}
    </div>`;
  }).join('') : `<div class="empty"><div>🤖</div><p>Hali bot yo'q</p>
      <p class="sm">Botda «➕ Bot yaratish» bosing</p></div>`;

  const txs = d.txs.map(t => `<div class="row">
      <span>${KIND[t.kind] ?? t.kind}<br><span class="sm muted">${esc(t.note ?? '')}</span></span>
      <b style="color:${t.amount > 0 ? 'var(--ok)' : 'inherit'}">
        ${t.amount > 0 ? '+' : '−'}${uzs(Math.abs(t.amount))}</b></div>`);

  app.innerHTML = `
    <h1>Salom, ${esc(d.name)}${d.isPremium ? ' 💎' : ''}</h1>
    <p class="sub">${d.isAdmin ? 'Platforma administratori' : 'Shaxsiy kabinet'}</p>
    <div class="hero anim"><span>Balans</span><b>${uzs(d.balance)}</b></div>
    <button class="wide" id="topup">➕ Balansni to'ldirish</button>
    <h2>Botlarim (${d.bots.length})</h2>${bots}
    ${foldable('tx', 'Balans harakati', txs)}`;
  countUp();
}

// ------------------------------------------------------------------- bot

let current = null;

async function renderBot(botId) {
  app.innerHTML = `<div class="skel hero"></div><div class="skel h"></div><div class="skel h"></div>`;
  const res = await api('/api/bot', { botId });
  if (!res.ok) return fail(res.error === 'forbidden' ? 'Bu bot sizniki emas' : "Ma'lumot olinmadi");
  current = res.data;
  paint('umumiy');
}

function paint(tab) {
  const d = current, s = d.stats;
  const [planLabel, planCls] = PLAN[d.plan?.status] ?? ['—', 'dim'];

  const tabs = ['umumiy', 'obunachilar', 'sotuv'];
  const extraTab = { kino:'kinolar', shop:'buyurtmalar', support:'murojaatlar', booking:'navbatlar',
                     contest:'konkurs', faq:'savollar', survey:'anketa', broadcast:'yuborishlar' }[d.template];
  if (extraTab) tabs.splice(1, 0, extraTab);

  const head = `
    <button class="tab ghost" id="back" style="margin-bottom:10px">◀️ Botlarim</button>
    <h1>@${esc(d.username)}</h1>
    <p class="sub">${TPL[d.template] ?? d.template} ·
      ${d.status === 'active' ? '🟢 ishlayapti' : "⚪️ to'xtatilgan"} ·
      <span class="pill ${planCls}">${planLabel}</span></p>
    <div class="tabs">${tabs.map(t =>
      `<button class="tab ${t === tab ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>`;

  app.innerHTML = head + (
    tab === 'umumiy' ? viewMain(d, s) :
    tab === 'obunachilar' ? viewUsers(d, s) :
    tab === 'sotuv' ? viewSelling(d) :
    viewTemplate(d)
  );
  countUp();
}

function viewMain(d, s) {
  return `<div class="grid">
      ${stat('👥', s.users, 'Obunachilar', 0)}
      ${stat('🆕', s.todayUsers, 'Bugun', 1)}
      ${stat('✅', s.active, 'Faol', 2)}
      ${stat('🚫', s.blocked, 'Bloklagan', 3)}
    </div>
    ${chart(d.chart)}
    ${d.plan ? ring(s.users, d.plan.maxUsers) : ''}
    ${d.plan ? `<div class="card anim">
      <div class="row"><span class="muted">Tarif</span><b>${esc(d.plan.name)}</b></div>
      ${d.plan.daysLeft != null ? `<div class="row"><span class="muted">Qolgan muddat</span>
        <b>${d.plan.daysLeft} kun</b></div>` : ''}
      <div class="row"><span class="muted">Yaratilgan</span>
        <b>${new Date(d.createdAt).toLocaleDateString('uz-UZ')}</b></div>
    </div>` : ''}`;
}

function viewUsers(d, s) {
  const total = Math.max(1, s.users);
  const bars = [['Faol', s.active, 'var(--ok)'], ['Bloklagan', s.blocked, 'var(--bad)'],
                ['Obunani bekor qilgan', s.unsubscribed, 'var(--warn)']];
  return `<div class="grid g3">
      ${stat('👥', s.users, 'Jami', 0)}
      ${stat('✅', s.active, 'Faol', 1)}
      ${stat('🚫', s.blocked, 'Bloklagan', 2)}
    </div>
    <div class="card anim">${bars.map(([label, value, colour]) => `
      <div style="margin-bottom:10px">
        <div class="row sm"><span class="muted">${label}</span><b>${num(value)}</b></div>
        <div style="height:6px;background:rgba(255,255,255,.07);border-radius:99px;margin-top:5px">
          <div style="height:100%;width:${Math.round(value / total * 100)}%;background:${colour};
            border-radius:99px;transition:width .6s ease"></div></div>
      </div>`).join('')}</div>
    ${chart(d.chart)}`;
}

function viewSelling(d) {
  const sell = d.selling;
  const plans = sell.plans.map(p => `<div class="row">
      <span>${esc(p.title)}<br><span class="sm muted">${p.days} kun</span></span>
      <b>${uzs(p.price)}</b></div>`);
  return `<div class="grid">
      ${stat('💎', sell.subscribers, 'Obunachilar', 0)}
      ${stat('💰', sell.revenue, "Tushum, so'm", 1)}
    </div>
    ${plans.length ? `<h2>Tariflaringiz</h2><div class="card anim">${plans.join('')}</div>`
      : `<div class="empty"><div>💎</div><p>Obuna tarifi yo'q</p>
         <p class="sm">Botda /admin → 💎 Obunalar orqali qo'shing</p></div>`}
    <div class="card anim sm muted">Pul to'g'ridan-to'g'ri sizning kartangizga tushadi —
      platforma komissiya olmaydi.</div>`;
}

function viewTemplate(d) {
  const e = d.extra;

  if (e.kino) {
    const rows = e.kino.top.map(m => `<div class="row">
      <span><code>${esc(m.code)}</code> ${esc(m.title)}</span><b>👁 ${num(m.views)}</b></div>`);
    return `<div class="grid">
        ${stat('🎬', e.kino.count, 'Kinolar', 0)}
        ${stat('👁', e.kino.views, "Ko'rishlar", 1)}
      </div>
      ${e.kino.channels.length ? `<div class="card anim"><div class="sm muted">Majburiy obuna</div>
        ${e.kino.channels.map(c => `<div>📢 ${esc(c)}</div>`).join('')}</div>` : ''}
      ${rows.length ? `<h2>Eng ko'p ko'rilgan</h2><div class="card anim">${rows.join('')}</div>`
        : `<div class="empty"><div>🎬</div><p>Hali kino yo'q</p></div>`}`;
  }

  if (e.shop) {
    const rows = e.shop.orders.map(o => {
      const [label, cls] = ORDER[o.status] ?? [o.status, 'dim'];
      return `<div class="row"><span>#${o.number} <span class="pill ${cls}">${label}</span><br>
        <span class="sm muted">${esc(o.address || o.phone)}</span>
        ${o.map ? `<br><a href="${o.map}" target="_blank" class="sm">🗺 Xaritada</a>` : ''}</span>
        <b>${uzs(o.total)}</b></div>`;
    });
    return `<div class="grid">
        ${stat('💰', e.shop.revenue, "Tushum, so'm", 0)}
        ${stat('📦', e.shop.orders.length, 'Buyurtmalar', 1)}
        ${stat('🛍', e.shop.products, 'Mahsulotlar', 2)}
        ${stat('📂', e.shop.categories, "Bo'limlar", 3)}
      </div>
      ${foldable('ord', 'Oxirgi buyurtmalar', rows)}
      ${foldable('cat', 'Katalog', e.shop.catalogue.map(p => `<div class="row">
        <span>${esc(p.title)}${p.active ? '' : ' <span class="pill dim">yashirin</span>'}</span>
        <b>${uzs(p.price)}</b></div>`))}`;
  }

  if (e.support) {
    const rows = e.support.tickets.map(t => {
      const [label, cls] = TICKET[t.status] ?? [t.status, 'dim'];
      return `<div class="row"><span>#${t.number} ${esc(t.who)}
        ${t.username ? `<span class="sm muted">@${esc(t.username)}</span>` : ''}<br>
        <span class="sm muted">${esc(t.last)}</span></span>
        <span class="pill ${cls}">${label}</span></div>`;
    });
    return `<div class="grid g3">
        ${stat('🔴', e.support.open, 'Kutilmoqda', 0)}
        ${stat('🟢', e.support.answered, 'Javob berilgan', 1)}
        ${stat('⚪️', e.support.closed, 'Yopilgan', 2)}
      </div>
      ${foldable('tk', 'Murojaatlar', rows)}`;
  }

  if (e.booking) {
    const rows = e.booking.slots.map(b => {
      const [label, cls] = BOOK[b.status] ?? [b.status, 'dim'];
      return `<div class="row"><span><b>${time(b.at)}</b> ${esc(b.service)}<br>
        <span class="sm muted">${day(b.at)} · ${esc(b.who)} · ${esc(b.phone)}</span></span>
        <span class="pill ${cls}">${label}</span></div>`;
    });
    return `<div class="grid">
        ${stat('📅', e.booking.today, 'Bugun', 0)}
        ${stat('⏭', e.booking.upcoming, 'Kelgusi', 1)}
        ${stat('✅', e.booking.done, "Bo'lgan", 2)}
        ${stat('❌', e.booking.canceled, 'Bekor', 3)}
      </div>
      ${foldable('bk', 'Navbatlar', rows)}`;
  }

  if (e.contest !== undefined) {
    const c = e.contest;
    if (!c) return `<div class="empty"><div>🎁</div><p>Konkurs yo'q</p></div>`;
    const winners = c.winners.map(w => `<div class="row"><span>🏆 ${esc(w.who)}
      ${w.username ? `<span class="sm muted">@${esc(w.username)}</span>` : ''}</span>
      <b>#${w.ticket}</b></div>`);
    return `<div class="card anim"><div class="row"><b>${esc(c.title)}</b>
        <span class="pill ${c.status === 'open' ? 'ok' : 'dim'}">
          ${c.status === 'open' ? 'Davom etmoqda' : 'Tugagan'}</span></div>
        ${c.prize ? `<div class="row"><span class="muted">Sovrin</span><b>${esc(c.prize)}</b></div>` : ''}
      </div>
      <div class="grid">
        ${stat('👥', c.entries, 'Ishtirokchilar', 0)}
        ${stat('🎖', c.winnerCount, "G'oliblar", 1)}
      </div>
      ${winners.length ? `<h2>G'oliblar</h2><div class="card anim">${winners.join('')}</div>` : ''}`;
  }

  if (e.faq) {
    const rows = e.faq.items.map(i => `<div class="row"><span>${esc(i.q)}</span>
      <b>👁 ${num(i.hits)}</b></div>`);
    return `<div class="grid">
        ${stat('📋', e.faq.count, 'Savollar', 0)}
        ${stat('👁', e.faq.hits, "So'ralgan", 1)}
      </div>
      ${foldable('fq', "So'ralish bo'yicha", rows)}`;
  }

  if (e.survey !== undefined) {
    const s = e.survey;
    if (!s) return `<div class="empty"><div>📋</div><p>Anketa yo'q</p></div>`;
    return `<div class="grid">
        ${stat('📝', s.questions.length, 'Savollar', 0)}
        ${stat('✅', s.responses, 'Javoblar', 1)}
      </div>
      ${foldable('sq', 'Savollar', s.questions.map((q, i) =>
        `<div class="row"><span>${i + 1}. ${esc(q)}</span></div>`))}`;
  }

  if (e.broadcast) {
    const rows = e.broadcast.recent.map(b => `<div class="row">
      <span>${day(b.at)}<br><span class="sm muted">${b.status}</span></span>
      <b>${num(b.sent)}/${num(b.total)}${b.failed ? ` · ⚠️ ${b.failed}` : ''}</b></div>`);
    return rows.length
      ? `<h2>Yuborishlar</h2><div class="card anim">${rows.join('')}</div>`
      : `<div class="empty"><div>📢</div><p>Hali xabar yuborilmagan</p></div>`;
  }

  return `<div class="empty"><div>📊</div><p>Qo'shimcha ma'lumot yo'q</p></div>`;
}

// CSP forbids inline handlers, and the markup is re-rendered constantly —
// one delegated listener survives both.
app.addEventListener('click', e => {
  const bot = e.target.closest('[data-bot]');
  if (bot) { tap(); return void renderBot(bot.dataset.bot); }

  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) { tap('soft'); return void paint(tabBtn.dataset.tab); }

  const fold = e.target.closest('[data-fold]');
  if (fold) {
    tap('soft');
    document.getElementById(`fold-${fold.dataset.fold}`)?.classList.toggle('open');
    document.getElementById(`chev-${fold.dataset.fold}`)?.classList.toggle('open');
    return;
  }

  if (e.target.closest('#back')) { tap(); current = null; return void renderOwner(); }
  if (e.target.closest('#topup')) { tap('medium'); tg?.close(); }
});

tg?.BackButton?.onClick(() => { current ? renderOwner() : tg.close(); });

const startParam = tg?.initDataUnsafe?.start_param
  || new URLSearchParams(location.search).get('bot');

(startParam && startParam !== 'wallet' ? renderBot(startParam) : renderOwner())
  .catch(err => fail('Xatolik yuz berdi', err.message));
