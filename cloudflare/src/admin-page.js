/**
 * admin-page.js — up112: the SEPARATE admin panel for 52 Online.
 *
 * Served by the Worker at GET /admin, only after it has verified
 * the session AND the admin email (worker.js) — this module just
 * renders. It is a standalone page (its own new UI, violet glass,
 * Dari) so the game client bundle stays under its size budget:
 * the in-game «ادمین» button simply navigates here, and the
 * panel's header links back to the game.
 *
 * Data comes from the /admin/* API (same origin, session cookie):
 *   GET  /admin/stats            dashboard counters
 *   GET  /admin/players?q&f&o    search / filter / page the players
 *   GET  /admin/player?id=       one player's full detail + ledger
 *   POST /admin/grant            grant / deduct coins|gems
 *   POST /admin/ban              ban / unban by 6-digit ID
 *   GET  /admin/clubs            club list
 *   POST /admin/broadcast        announcement into every inbox
 *   POST /admin/notice           private announcement to one player
 *   GET  /admin/grants           recent grants (dashboard)
 *   GET  /admin/log              unified admin action log
 *
 * The page script deliberately uses string concatenation only —
 * this whole document rides one template literal.
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function adminPage(user) {
  const email = esc(user && user.email);
  const name = esc((user && user.name) || '');
  return '<!DOCTYPE html>\n<html lang="fa" dir="rtl">\n<head>\n<meta charset="utf-8">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
    + '<meta name="robots" content="noindex, nofollow">\n'
    + '<title>پنل مدیریت — 52 Online</title>\n<style>\n'
    + '*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}'
    + ':root{--bg1:#150d2b;--bg2:#241447;--card:rgba(255,255,255,.055);--card2:rgba(255,255,255,.09);--line:rgba(255,255,255,.10);--txt:#f3efff;--mut:#b6a9d9;--vio:#8b5cf6;--gold:#f5c542;--gem:#67e8f9;--grn:#34d399;--red:#fb7185}'
    + 'body{font-family:"Segoe UI",Tahoma,sans-serif;color:var(--txt);min-height:100vh;background:radial-gradient(600px 300px at 85% -60px,rgba(139,92,246,.35),transparent 60%),radial-gradient(500px 260px at 0% 30%,rgba(245,197,66,.10),transparent 55%),linear-gradient(165deg,var(--bg2),var(--bg1) 55%);padding:18px 14px 96px;max-width:430px;margin:0 auto}'
    + '.view{display:none}.view.on{display:block;animation:fade .25s ease}@keyframes fade{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}'
    + '.hd{display:flex;align-items:center;gap:12px;margin-bottom:16px}'
    + '.hd .shield{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;flex:0 0 auto;background:linear-gradient(145deg,#7c3aed,#4c1d95);border:1px solid rgba(255,255,255,.22);box-shadow:0 10px 24px rgba(124,58,237,.45)}'
    + '.hd .shield svg{width:28px;height:28px;fill:#fff}'
    + '.hd h1{font-size:19px;font-weight:800}.hd .sub{color:var(--mut);font-size:11.5px;margin-top:2px;direction:ltr;text-align:right}'
    + '.back{margin-inline-start:auto;flex:0 0 auto;text-decoration:none;color:var(--txt);font-size:12px;background:var(--card);border:1px solid var(--line);padding:8px 12px;border-radius:999px}'
    + '.stats{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px}'
    + '.stat{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:13px 14px}'
    + '.stat .k{color:var(--mut);font-size:12px}.stat .v{font-size:23px;font-weight:800;margin-top:4px;direction:ltr;text-align:right}.stat .d{font-size:11px;margin-top:2px;color:var(--grn)}'
    + '.sec{font-size:14px;font-weight:700;margin:16px 2px 10px;display:flex;align-items:center;gap:8px}.sec::after{content:"";flex:1;height:1px;background:var(--line)}'
    + '.card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:12px}'
    + '.qa{display:grid;grid-template-columns:repeat(4,1fr);gap:9px}'
    + '.qa a{text-decoration:none;color:var(--txt);background:var(--card);border:1px solid var(--line);border-radius:16px;padding:11px 4px 9px;text-align:center;font-size:11.5px}'
    + '.qa .ic{width:38px;height:38px;margin:0 auto 6px;border-radius:12px;display:grid;place-items:center;font-size:19px}'
    + '.ic.v{background:linear-gradient(145deg,#8b5cf6,#6d28d9)}.ic.g{background:linear-gradient(145deg,#f59e0b,#b45309)}.ic.c{background:linear-gradient(145deg,#0891b2,#155e75)}.ic.r{background:linear-gradient(145deg,#e11d48,#881337)}'
    + '.row{display:flex;align-items:center;gap:10px;padding:10px 6px;border-bottom:1px solid rgba(255,255,255,.06);cursor:pointer}.row:last-child{border-bottom:none}.row.nc{cursor:default}'
    + '.av{width:42px;height:42px;border-radius:50%;flex:0 0 auto;display:grid;place-items:center;font-weight:800;font-size:15px;color:#fff;background:linear-gradient(145deg,#7c3aed,#312e81);border:2px solid rgba(255,255,255,.18);position:relative;overflow:visible}'
    + '.av img{width:100%;height:100%;border-radius:50%;object-fit:cover}'
    + '.av .on{position:absolute;bottom:0;inset-inline-start:0;width:11px;height:11px;border-radius:50%;background:var(--grn);border:2px solid #1d1436;z-index:2}'
    + '.row .nm{font-size:14px;font-weight:700}.row .mt{color:var(--mut);font-size:11.5px;margin-top:1px}'
    + '.row .end{margin-inline-start:auto;text-align:left;flex:0 0 auto}'
    + '.bal{font-size:12.5px;font-weight:700;direction:ltr;line-height:1.7}.bal .g{color:var(--gold)}.bal .d{color:var(--gem)}'
    + '.tag{font-size:10.5px;padding:3px 8px;border-radius:999px;border:1px solid var(--line);color:var(--mut);display:inline-block}'
    + '.tag.ban{color:#fda4af;border-color:rgba(251,113,133,.4);background:rgba(251,113,133,.10)}'
    + '.tag.onl{color:var(--grn);border-color:rgba(52,211,153,.35);background:rgba(52,211,153,.08)}'
    + '.amt{font-weight:800;direction:ltr;font-size:14px}.amt.plus{color:var(--grn)}.amt.min{color:var(--red)}'
    + '.search{display:flex;gap:8px;margin-bottom:10px}'
    + '.search input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:14px;color:var(--txt);padding:12px 14px;font-size:14px;font-family:inherit;outline:none}'
    + '.search input::placeholder{color:var(--mut)}'
    + '.search button{border:none;border-radius:14px;background:linear-gradient(145deg,#8b5cf6,#6d28d9);color:#fff;font-family:inherit;font-weight:700;font-size:13px;padding:0 16px;cursor:pointer}'
    + '.chips{display:flex;gap:7px;margin-bottom:12px;flex-wrap:wrap}'
    + '.chip{font-size:12px;padding:7px 13px;border-radius:999px;border:1px solid var(--line);color:var(--mut);background:var(--card);cursor:pointer}'
    + '.chip.act{background:var(--vio);border-color:var(--vio);color:#fff;font-weight:700}'
    + '.more{width:100%;margin-top:12px;border:1px solid var(--line);background:var(--card);color:var(--txt);border-radius:14px;padding:12px;font-family:inherit;font-size:13.5px;cursor:pointer}'
    + '.phd{text-align:center;padding:4px 0}.phd .av{width:74px;height:74px;font-size:26px;margin:0 auto 8px}.phd h2{font-size:19px;font-weight:800}.phd .mt{color:var(--mut);font-size:12.5px;margin-top:3px;line-height:1.9}'
    + '.pstats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0 2px}'
    + '.pstats .stat{padding:10px 4px;text-align:center;border-radius:14px}.pstats .v{font-size:16.5px;text-align:center}.pstats .k{font-size:11px}'
    + '.grant{display:flex;gap:8px;align-items:stretch}'
    + '.grant .cur{display:flex;border:1px solid var(--line);border-radius:13px;overflow:hidden;flex:0 0 auto}'
    + '.grant .cur b{padding:11px 12px;font-size:13px;background:var(--vio);cursor:pointer}.grant .cur span{padding:11px 12px;font-size:13px;color:var(--mut);background:var(--card);cursor:pointer}'
    + '.grant input{flex:1;min-width:0;background:var(--card);border:1px solid var(--line);border-radius:13px;color:var(--txt);padding:11px 12px;font-size:15px;font-family:inherit;outline:none;text-align:center}'
    + '.btns{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:10px}'
    + '.btn{border:none;border-radius:14px;padding:13px;font-size:14px;font-weight:800;font-family:inherit;cursor:pointer;color:#fff}'
    + '.btn.send{background:linear-gradient(145deg,#8b5cf6,#6d28d9);box-shadow:0 8px 20px rgba(124,58,237,.4)}'
    + '.btn.take{background:rgba(251,113,133,.14);color:#fda4af;border:1px solid rgba(251,113,133,.4)}'
    + '.btn.ban{background:rgba(251,113,133,.14);color:#fda4af;border:1px solid rgba(251,113,133,.4)}'
    + '.btn.unban{background:rgba(52,211,153,.14);color:#6ee7b7;border:1px solid rgba(52,211,153,.4)}'
    + '.btn.msg{background:var(--card2);border:1px solid var(--line)}'
    + '.quick{display:flex;gap:7px;margin-top:9px}'
    + '.quick span{flex:1;text-align:center;font-size:12px;padding:8px 0;border-radius:10px;background:var(--card);border:1px solid var(--line);color:var(--mut);direction:ltr;cursor:pointer}'
    + 'textarea{width:100%;background:var(--card);border:1px solid var(--line);border-radius:14px;color:var(--txt);padding:12px 14px;font-size:14px;font-family:inherit;outline:none;resize:vertical;min-height:84px}'
    + '.wide{width:100%;margin-top:10px}'
    + '.note{text-align:center;color:var(--mut);font-size:11px;margin-top:14px;line-height:1.9}'
    + '.empty{color:var(--mut);text-align:center;padding:18px 6px;font-size:13px}'
    + '.toast{position:fixed;bottom:96px;inset-inline:14px;max-width:402px;margin:0 auto;background:rgba(38,24,74,.96);border:1px solid rgba(139,92,246,.5);color:#fff;border-radius:14px;padding:12px 14px;font-size:13.5px;text-align:center;opacity:0;pointer-events:none;transition:opacity .25s;z-index:9}'
    + '.toast.show{opacity:1}'
    + '.nav{position:fixed;bottom:12px;inset-inline:14px;max-width:402px;margin:0 auto;display:flex;z-index:5;background:rgba(29,20,54,.9);border:1px solid var(--line);border-radius:22px;padding:8px;backdrop-filter:blur(14px);box-shadow:0 14px 34px rgba(0,0,0,.45)}'
    + '.nav a{flex:1;text-align:center;text-decoration:none;color:var(--mut);font-size:11px;padding:7px 0 5px;border-radius:15px;cursor:pointer}'
    + '.nav a .ni{font-size:19px;display:block;margin-bottom:2px}'
    + '.nav a.act{background:linear-gradient(145deg,#8b5cf6,#6d28d9);color:#fff;font-weight:700}'
    + '</style>\n</head>\n<body>\n'

    // header
    + '<div class="hd"><div class="shield"><svg viewBox="0 0 24 24"><path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5l8-3z"/><path d="M9.2 12.2l2 2 3.8-4" stroke="#4c1d95" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg></div>'
    + '<div><h1>پنل مدیریت 52 Online</h1><div class="sub">' + email + '</div></div>'
    + '<a class="back" href="/">🎮 بازگشت به بازی</a></div>\n'

    // dashboard
    + '<section class="view" id="v-dash">'
    + '<div class="stats">'
    + '<div class="stat"><div class="k">👥 کل بازیکن‌ها</div><div class="v" id="st-players">…</div><div class="d" id="st-active"></div></div>'
    + '<div class="stat"><div class="k">🟢 آنلاین حالا</div><div class="v" id="st-online">…</div><div class="d" id="st-ingame"></div></div>'
    + '<div class="stat"><div class="k">🪙 سکه در گردش</div><div class="v" id="st-coins">…</div><div class="d">در همهٔ کیف‌ها</div></div>'
    + '<div class="stat"><div class="k">💎 الماس در گردش</div><div class="v" id="st-gems">…</div><div class="d" id="st-clubs"></div></div>'
    + '</div>'
    + '<div class="sec">دسترسی سریع</div><div class="qa">'
    + '<a data-go="players"><span class="ic g">＋</span>ارسال سکه</a>'
    + '<a data-go="players"><span class="ic v">👤</span>بازیکن‌ها</a>'
    + '<a data-go="cast"><span class="ic c">📣</span>اعلان عمومی</a>'
    + '<a data-go="log"><span class="ic r">🕘</span>تاریخچه</a>'
    + '</div>'
    + '<div class="sec">آخرین ارسال‌ها</div><div class="card" id="dash-grants"><div class="empty">در حال بارگذاری…</div></div>'
    + '<div class="sec">کلب‌های برتر</div><div class="card" id="dash-clubs"><div class="empty">در حال بارگذاری…</div></div>'
    + '<p class="note">این پنل فقط با ایمیل رسمی تو باز می‌شود — بازیکن‌های عادی آن را نمی‌بینند.</p>'
    + '</section>\n'

    // players
    + '<section class="view" id="v-players">'
    + '<div class="search"><input id="pq" placeholder="جستجو با آیدی ۶ رقمی یا نام…"><button id="pq-go">بگرد</button></div>'
    + '<div class="chips" id="p-chips">'
    + '<span class="chip act" data-f="all">همه</span><span class="chip" data-f="online">آنلاین</span><span class="chip" data-f="banned">بن‌شده</span><span class="chip" data-f="rich">ثروتمندترین</span>'
    + '</div>'
    + '<div class="card" id="p-list"><div class="empty">در حال بارگذاری…</div></div>'
    + '<button class="more hidden" id="p-more" style="display:none">بیشتر نشان بده</button>'
    + '<p class="note">روی هر بازیکن بزن تا پروفایل کامل، تاریخچهٔ کیف پول و دکمه‌های بن/ارسال باز شود.</p>'
    + '</section>\n'

    // player detail
    + '<section class="view" id="v-player">'
    + '<div class="phd" id="pd-head"></div>'
    + '<div class="pstats" id="pd-stats"></div>'
    + '<div class="sec">ارسال / کم‌کردن</div><div class="card">'
    + '<div class="grant"><div class="cur"><b id="cur-coins">🪙 سکه</b><span id="cur-gems">💎 الماس</span></div>'
    + '<input id="pd-amt" type="text" inputmode="numeric" dir="ltr" placeholder="50,000"></div>'
    + '<div class="quick"><span data-amt="1000">+1,000</span><span data-amt="10000">+10,000</span><span data-amt="50000">+50,000</span><span data-amt="100000">+100,000</span></div>'
    + '<div class="btns"><button class="btn send" id="pd-send">ارسال کن</button><button class="btn take" id="pd-take">کم کن</button></div>'
    + '</div>'
    + '<div class="sec">مدیریت بازیکن</div>'
    + '<div class="card"><textarea id="pd-note" maxlength="200" placeholder="متن اعلان خصوصی برای این بازیکن…"></textarea>'
    + '<div class="btns"><button class="btn msg" id="pd-notice">📩 ارسال اعلان خصوصی</button><button class="btn ban" id="pd-ban">⛔ بن‌کردن بازیکن</button></div></div>'
    + '<div class="sec">تاریخچهٔ کیف پول</div><div class="card" id="pd-ledger"><div class="empty">—</div></div>'
    + '<button class="more" id="pd-back">← بازگشت به لیست بازیکن‌ها</button>'
    + '</section>\n'

    // clubs
    + '<section class="view" id="v-clubs"><div class="sec" style="margin-top:2px">همهٔ کلب‌ها</div>'
    + '<div class="card" id="c-list"><div class="empty">در حال بارگذاری…</div></div></section>\n'

    // broadcast
    + '<section class="view" id="v-cast"><div class="sec" style="margin-top:2px">اعلان عمومی</div>'
    + '<div class="card"><p style="color:var(--mut);font-size:12.5px;line-height:2;margin-bottom:10px">این پیام به صندوق اعلانِ <b style="color:var(--txt)">همهٔ بازیکن‌ها</b> می‌رود (حداکثر ۲۰۰ حرف). بازیکن آنلاین همان لحظه می‌بیند؛ آفلاین‌ها در ورود بعدی.</p>'
    + '<textarea id="cast-text" maxlength="200" placeholder="مثلاً: امشب ساعت ۹ مسابقهٔ بزرگ کلب‌ها شروع می‌شود! 🏆"></textarea>'
    + '<button class="btn send wide" id="cast-send">📣 ارسال به همه</button></div>'
    + '<p class="note">قبل از ارسال، متن را یک بار دیگر بخوان — اعلان رفته را نمی‌شود پس گرفت.</p></section>\n'

    // log
    + '<section class="view" id="v-log"><div class="sec" style="margin-top:2px">تاریخچهٔ کارهای ادمین</div>'
    + '<div class="card" id="l-list"><div class="empty">در حال بارگذاری…</div></div></section>\n'

    + '<div class="toast" id="toast"></div>\n'

    // bottom nav
    + '<nav class="nav">'
    + '<a data-go="dash" class="act"><span class="ni">▦</span>داشبورد</a>'
    + '<a data-go="players"><span class="ni">👤</span>بازیکن‌ها</a>'
    + '<a data-go="clubs"><span class="ni">🏠</span>کلب‌ها</a>'
    + '<a data-go="cast"><span class="ni">📣</span>اعلان</a>'
    + '<a data-go="log"><span class="ni">🕘</span>تاریخچه</a>'
    + '</nav>\n'

    + '<script>\n'
    + 'var $ = function(s){ return document.querySelector(s); };\n'
    + 'var $$ = function(s){ return Array.prototype.slice.call(document.querySelectorAll(s)); };\n'
    + 'var PD = "۰۱۲۳۴۵۶۷۸۹";\n'
    + 'function faNum(n){ if (n == null || n === "") return "—"; var s = String(Math.round(Number(n))); var neg = s.charAt(0) === "-"; if (neg) s = s.slice(1); s = s.replace(/\\B(?=(\\d{3})+(?!\\d))/g, ","); s = s.replace(/\\d/g, function(d){ return PD[Number(d)]; }); return (neg ? "−" : "") + s; }\n'
    + 'function faInt(v){ var s = String(v || "").replace(/[^0-9]/g, ""); var n = parseInt(s, 10); return isNaN(n) ? 0 : n; }\n'
    + 'function rel(ts){ if (!ts) return "—"; var d = Date.now() - ts; if (d < 60000) return "همین حالا"; if (d < 3600000) return faNum(Math.floor(d / 60000)) + " دقیقه پیش"; if (d < 86400000) return faNum(Math.floor(d / 3600000)) + " ساعت پیش"; return faNum(Math.floor(d / 86400000)) + " روز پیش"; }\n'
    + 'function escT(s){ var d = document.createElement("div"); d.textContent = String(s == null ? "" : s); return d.innerHTML; }\n'
    + 'function toast(m){ var t = $("#toast"); t.textContent = m; t.classList.add("show"); setTimeout(function(){ t.classList.remove("show"); }, 2600); }\n'
    + 'async function api(path, opts){ try { var r = await fetch(path, Object.assign({ credentials: "same-origin" }, opts || {})); var j = null; try { j = await r.json(); } catch (e) {} return { ok: r.ok, j: j }; } catch (e) { return { ok: false, j: null }; } }\n'
    + 'function avHtml(p, big){ var inner; if (p.photo) inner = "<img src=\\"" + escT(p.photo) + "\\" alt=\\"\\">"; else inner = escT((p.name || "؟").trim().charAt(0) || "؟"); return "<div class=\\"av\\">" + inner + (p.online ? "<span class=\\"on\\"></span>" : "") + "</div>"; }\n'
    // navigation
    + 'var curView = "dash";\n'
    + 'function go(v){ curView = v; $$(".view").forEach(function(s){ s.classList.toggle("on", s.id === "v-" + v); }); $$(".nav a").forEach(function(a){ a.classList.toggle("act", a.getAttribute("data-go") === v || (v === "player" && a.getAttribute("data-go") === "players")); }); window.scrollTo(0, 0); if (v === "dash") loadDash(); if (v === "players") loadPlayers(false); if (v === "clubs") loadClubs(); if (v === "log") loadLog(); }\n'
    + '$$("[data-go]").forEach(function(a){ a.addEventListener("click", function(){ go(a.getAttribute("data-go")); }); });\n'
    // dashboard
    + 'async function loadDash(){ var r = await api("/admin/stats"); if (r.ok && r.j && r.j.stats){ var s = r.j.stats; $("#st-players").textContent = faNum(s.players); $("#st-active").textContent = "▲ " + faNum(s.activeToday) + " نفر امروز فعال"; $("#st-online").textContent = faNum(s.online); $("#st-ingame").textContent = faNum(s.ingame) + " نفر داخل بازی"; $("#st-coins").textContent = faNum(s.coins); $("#st-gems").textContent = faNum(s.gems); $("#st-clubs").textContent = faNum(s.clubs) + " کلب فعال"; }'
    + ' var g = await api("/admin/grants"); var box = $("#dash-grants"); if (g.ok && g.j && g.j.grants && g.j.grants.length){ box.innerHTML = ""; g.j.grants.slice(0, 5).forEach(function(x){ var row = document.createElement("div"); row.className = "row nc"; row.innerHTML = avHtml({ name: x.name, online: false }) + "<div><div class=\\"nm\\">" + escT(x.name) + "</div><div class=\\"mt\\">آیدی " + faNum(x.uid) + " · " + rel(x.ts) + "</div></div><div class=\\"end\\"><div class=\\"amt " + (x.amount > 0 ? "plus" : "min") + "\\">" + (x.amount > 0 ? "+" : "−") + faNum(Math.abs(x.amount)) + "</div><div class=\\"mt\\">" + (x.currency === "gems" ? "الماس 💎" : "سکه 🪙") + "</div></div>"; box.appendChild(row); }); } else { box.innerHTML = "<div class=\\"empty\\">هنوز ارسالی ثبت نشده</div>"; }'
    + ' var c = await api("/admin/clubs"); var cb = $("#dash-clubs"); if (c.ok && c.j && c.j.clubs && c.j.clubs.length){ cb.innerHTML = ""; c.j.clubs.slice(0, 3).forEach(function(x){ var row = document.createElement("div"); row.className = "row nc"; row.innerHTML = avHtml({ name: x.name, online: false }) + "<div><div class=\\"nm\\">" + escT(x.name) + "</div><div class=\\"mt\\">آیدی " + faNum(x.cid) + " · مالک: " + escT(x.ownerName) + "</div></div><div class=\\"end\\"><span class=\\"tag onl\\">" + faNum(x.members) + " عضو</span></div>"; cb.appendChild(row); }); } else { cb.innerHTML = "<div class=\\"empty\\">کلوبی نیست</div>"; } }\n'
    // players
    + 'var pFilter = "all", pOffset = 0, pTotal = 0;\n'
    + '$$("#p-chips .chip").forEach(function(ch){ ch.addEventListener("click", function(){ $$("#p-chips .chip").forEach(function(x){ x.classList.remove("act"); }); ch.classList.add("act"); pFilter = ch.getAttribute("data-f"); loadPlayers(false); }); });\n'
    + '$("#pq-go").addEventListener("click", function(){ loadPlayers(false); });\n'
    + '$("#pq").addEventListener("keydown", function(e){ if (e.key === "Enter") loadPlayers(false); });\n'
    + '$("#p-more").addEventListener("click", function(){ loadPlayers(true); });\n'
    + 'function playerRow(x){ var row = document.createElement("div"); row.className = "row"; row.innerHTML = avHtml(x) + "<div><div class=\\"nm\\">" + escT(x.name) + (x.banned ? " <span class=\\"tag ban\\">بن‌شده</span>" : "") + "</div><div class=\\"mt\\">آیدی " + faNum(x.uid) + " · سطح " + faNum(x.level) + " · " + faNum(x.wins) + " برد" + (x.ingame ? " · داخل بازی" : (x.online ? "" : " · " + rel(x.lastSeen))) + "</div></div><div class=\\"end\\"><div class=\\"bal\\"><span class=\\"g\\">🪙 " + faNum(x.coins) + "</span><br><span class=\\"d\\">💎 " + faNum(x.gems) + "</span></div></div>"; row.addEventListener("click", function(){ openPlayer(x.uid); }); return row; }\n'
    + 'async function loadPlayers(more){ if (!more) pOffset = 0; var q = encodeURIComponent($("#pq").value.trim()); var r = await api("/admin/players?q=" + q + "&f=" + pFilter + "&o=" + pOffset); var box = $("#p-list"); if (!r.ok || !r.j){ if (!more) box.innerHTML = "<div class=\\"empty\\">خطا در بارگذاری</div>"; return; } pTotal = r.j.total || 0; if (!more) box.innerHTML = ""; if (!r.j.rows.length && !more) box.innerHTML = "<div class=\\"empty\\">بازیکنی پیدا نشد</div>"; r.j.rows.forEach(function(x){ box.appendChild(playerRow(x)); }); pOffset += r.j.rows.length; $("#p-more").style.display = pOffset < pTotal ? "block" : "none"; }\n'
    // player detail
    + 'var curPlayer = null, curCur = "coins";\n'
    + 'function setCur(c){ curCur = c; $("#cur-coins").style.background = c === "coins" ? "var(--vio)" : "var(--card)"; $("#cur-coins").style.color = c === "coins" ? "#fff" : "var(--mut)"; $("#cur-gems").style.background = c === "gems" ? "var(--vio)" : "var(--card)"; $("#cur-gems").style.color = c === "gems" ? "#fff" : "var(--mut)"; }\n'
    + '$("#cur-coins").addEventListener("click", function(){ setCur("coins"); });\n'
    + '$("#cur-gems").addEventListener("click", function(){ setCur("gems"); });\n'
    + '$$(".quick span").forEach(function(sp){ sp.addEventListener("click", function(){ $("#pd-amt").value = sp.getAttribute("data-amt"); }); });\n'
    + '$("#pd-back").addEventListener("click", function(){ go("players"); });\n'
    + 'var KIND = { grant: "هدیه", bonus: "جایزه روزانه", chest: "صندوق", stake: "شرط بازی", win: "برد بازی", refund: "برگشت", buy: "خرید فروشگاه", forfeit: "ترک بازی", admin: "ارسال ادمین", gift: "هدیه از بازیکن" };\n'
    + 'async function openPlayer(uid){ if (!uid) return; go("player"); $("#pd-head").innerHTML = "<div class=\\"empty\\">در حال بارگذاری…</div>"; $("#pd-stats").innerHTML = ""; $("#pd-ledger").innerHTML = ""; var r = await api("/admin/player?id=" + encodeURIComponent(uid)); if (!r.ok || !r.j || !r.j.player){ $("#pd-head").innerHTML = "<div class=\\"empty\\">بازیکن پیدا نشد</div>"; return; } var p = r.j.player; curPlayer = p;'
    + ' $("#pd-head").innerHTML = "<div style=\\"display:flex;justify-content:center\\">" + avHtml(p, true) + "</div><h2 style=\\"margin-top:8px\\">" + escT(p.name) + (p.banned ? " <span class=\\"tag ban\\">بن‌شده</span>" : "") + "</h2><div class=\\"mt\\">آیدی " + faNum(p.uid) + " · سطح " + faNum(p.level) + (p.club ? " · عضو کلب " + escT(p.club.name) : "") + " · " + faNum(p.friends) + " دوست<br>" + (p.ingame ? "<span style=\\"color:var(--grn)\\">آنلاین — داخل بازی</span>" : (p.online ? "<span style=\\"color:var(--grn)\\">آنلاین</span>" : "آخرین بازدید: " + rel(p.lastSeen))) + "</div>";'
    + ' var cells = [["🪙 سکه", p.coins, "var(--gold)"], ["💎 الماس", p.gems, "var(--gem)"], ["🏆 برد", p.wins, ""], ["باخت", p.losses, ""]]; $("#pd-stats").innerHTML = cells.map(function(c){ return "<div class=\\"stat\\"><div class=\\"k\\">" + c[0] + "</div><div class=\\"v\\" style=\\"" + (c[2] ? "color:" + c[2] : "") + "\\">" + faNum(c[1]) + "</div></div>"; }).join("");'
    + ' var banBtn = $("#pd-ban"); if (p.banned){ banBtn.textContent = "✅ برداشتن بن"; banBtn.className = "btn unban"; } else { banBtn.textContent = "⛔ بن‌کردن بازیکن"; banBtn.className = "btn ban"; }'
    + ' var lb = $("#pd-ledger"); if (p.ledger && p.ledger.length){ lb.innerHTML = ""; p.ledger.forEach(function(e){ var row = document.createElement("div"); row.className = "row nc"; row.innerHTML = "<div><div class=\\"nm\\" style=\\"font-size:13px\\">" + escT(KIND[e.kind] || e.kind) + (e.cur === "gems" ? " 💎" : " 🪙") + "</div><div class=\\"mt\\">" + rel(e.ts) + "</div></div><div class=\\"end\\"><div class=\\"amt " + (e.amount > 0 ? "plus" : "min") + "\\">" + (e.amount > 0 ? "+" : "−") + faNum(Math.abs(e.amount)) + "</div></div>"; lb.appendChild(row); }); } else { lb.innerHTML = "<div class=\\"empty\\">تراکنشی ثبت نشده</div>"; } }\n'
    + 'async function doGrant(sign){ if (!curPlayer) return; var amt = faInt($("#pd-amt").value) * sign; if (!amt) { toast("⚠️ اول مقدار را بنویس"); return; } var label = (amt > 0 ? "+" : "−") + faNum(Math.abs(amt)) + (curCur === "gems" ? " 💎 الماس" : " 🪙 سکه"); if (!confirm(label + " برای " + curPlayer.name + "؟")) return; var r = await api("/admin/grant", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: curPlayer.uid, currency: curCur, amount: amt }) }); if (r.ok && r.j && r.j.ok){ toast("✓ انجام شد — موجودی تازه: 🪙 " + faNum(r.j.coins) + " · 💎 " + faNum(r.j.gems)); openPlayer(curPlayer.uid); } else { toast("✗ نشد: " + ((r.j && r.j.error) || "خطا")); } }\n'
    + '$("#pd-send").addEventListener("click", function(){ doGrant(1); });\n'
    + '$("#pd-take").addEventListener("click", function(){ doGrant(-1); });\n'
    + '$("#pd-ban").addEventListener("click", async function(){ if (!curPlayer) return; var target = !curPlayer.banned; if (!confirm(target ? ("بازیکن " + curPlayer.name + " بن شود؟ دیگر نمی‌تواند بازی بسازد یا وارد بازی شود.") : ("بن " + curPlayer.name + " برداشته شود؟"))) return; var r = await api("/admin/ban", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: curPlayer.uid, banned: target }) }); if (r.ok && r.j && r.j.ok){ toast(target ? "⛔ بن شد" : "✅ بن برداشته شد"); openPlayer(curPlayer.uid); } else { toast("✗ نشد"); } });\n'
    + '$("#pd-notice").addEventListener("click", async function(){ if (!curPlayer) return; var t = $("#pd-note").value.trim(); if (!t) { toast("⚠️ اول متن اعلان را بنویس"); return; } var r = await api("/admin/notice", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ playerId: curPlayer.uid, text: t }) }); if (r.ok && r.j && r.j.ok){ toast("📩 اعلان خصوصی ارسال شد"); $("#pd-note").value = ""; } else { toast("✗ نشد"); } });\n'
    // clubs
    + 'async function loadClubs(){ var r = await api("/admin/clubs"); var box = $("#c-list"); if (!r.ok || !r.j || !r.j.clubs || !r.j.clubs.length){ box.innerHTML = "<div class=\\"empty\\">کلوبی نیست</div>"; return; } box.innerHTML = ""; r.j.clubs.forEach(function(x){ var row = document.createElement("div"); row.className = "row nc"; row.innerHTML = avHtml({ name: x.name, online: false }) + "<div><div class=\\"nm\\">" + escT(x.name) + "</div><div class=\\"mt\\">آیدی " + faNum(x.cid) + " · مالک: " + escT(x.ownerName) + " (" + faNum(x.ownerUid) + ")</div></div><div class=\\"end\\"><span class=\\"tag onl\\">" + faNum(x.members) + " عضو</span></div>"; box.appendChild(row); }); }\n'
    // broadcast
    + '$("#cast-send").addEventListener("click", async function(){ var t = $("#cast-text").value.trim(); if (!t) { toast("⚠️ اول متن اعلان را بنویس"); return; } if (!confirm("این اعلان به همهٔ بازیکن‌ها ارسال شود؟")) return; var r = await api("/admin/broadcast", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) }); if (r.ok && r.j && r.j.ok){ toast("📣 به " + faNum(r.j.sent) + " بازیکن ارسال شد"); $("#cast-text").value = ""; } else { toast("✗ نشد: " + ((r.j && r.j.error) || "خطا")); } });\n'
    // log
    + 'var ACT = { grant: "ارسال", ban: "⛔ بن", unban: "✅ برداشتن بن", broadcast: "📣 اعلان عمومی", notice: "📩 اعلان خصوصی" };\n'
    + 'async function loadLog(){ var r = await api("/admin/log"); var box = $("#l-list"); if (!r.ok || !r.j || !r.j.log || !r.j.log.length){ box.innerHTML = "<div class=\\"empty\\">هنوز کاری ثبت نشده</div>"; return; } box.innerHTML = ""; r.j.log.forEach(function(e){ var row = document.createElement("div"); row.className = "row nc"; var title = ACT[e.action] || e.action; var sub = rel(e.ts); var right = ""; if (e.action === "grant"){ title += " برای " + (e.name || ""); right = "<div class=\\"amt " + (e.amount > 0 ? "plus" : "min") + "\\">" + (e.amount > 0 ? "+" : "−") + faNum(Math.abs(e.amount)) + "</div><div class=\\"mt\\">" + (e.currency === "gems" ? "الماس 💎" : "سکه 🪙") + "</div>"; } else if (e.action === "broadcast"){ title += " به " + faNum(e.sent) + " بازیکن"; sub += " · «" + (e.text || "") + "»"; } else if (e.name){ title += " — " + e.name; if (e.text) sub += " · «" + e.text + "»"; } row.innerHTML = "<div><div class=\\"nm\\" style=\\"font-size:13.5px\\">" + escT(title) + "</div><div class=\\"mt\\">" + escT(sub) + "</div></div><div class=\\"end\\">" + right + "</div>"; box.appendChild(row); }); }\n'
    + 'setCur("coins"); go("dash");\n'
    + '</' + 'script>\n</body>\n</html>';
}
