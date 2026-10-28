// RINAE+ ek paketi
// Kelime türetmece, sayı sayma, bakım modu, komut önerisi, güvenli yeniden başlatma,
// geliştirici konsolu, tam yetki (sahip ID), etiketle-sor (veri soruları), çoklu sunucu ayarı.
// index.js ile aynı klasöre koy. index.js'in EN BAŞINDA require edilmelidir (dosya güvenlik katmanı için).
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CREATOR_ID = String(process.env.CREATOR_ID || '1500'); // RINAE'nin sahibi/oluşturucusu
const DIR = __dirname;
const TR = 3 * 3600e3; // Türkiye saati (UTC+3)
const DAY = 864e5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trLower = (t) => String(t ?? '').toLocaleLowerCase('tr-TR');

// =====================================================================
// 1) GÜVENLİ DOSYA KATMANI
//    ayarlar/kayitlar/veri json dosyaları: önce geçici dosyaya yazılır, geçerli JSON mu diye
//    kontrol edilir, eski sürüm .bak olarak saklanır, sonra yer değiştirilir.
//    Okurken dosya bozuksa otomatik .bak'tan yüklenir. Çökme anında yarım yazılmış dosya kalmaz.
// =====================================================================
const MANAGED = ['ayarlar.json', 'kayitlar.json', 'veri.json', 'rinae-plus.json', 'rinae-sozluk.json']
  .map((n) => path.join(DIR, n));
const rawWrite = fs.writeFileSync.bind(fs);
const rawRead = fs.readFileSync.bind(fs);
const managed = (f) => typeof f === 'string' && MANAGED.includes(path.resolve(f));
const validJson = (file) => { try { JSON.parse(rawRead(file, 'utf-8')); return true; } catch { return false; } };

if (!fs.__rinaeSafe) {
  fs.__rinaeSafe = true;
  fs.writeFileSync = function (file, data, ...rest) {
    if (!managed(file)) return rawWrite(file, data, ...rest);
    const text = typeof data === 'string' ? data : String(data);
    JSON.parse(text); // bozuk/yarım veri asla dosyaya yazılmaz
    const tmp = file + '.tmp';
    rawWrite(tmp, text, 'utf-8');
    if (fs.existsSync(file) && validJson(file)) { try { fs.copyFileSync(file, file + '.bak'); } catch { /* yoksay */ } }
    try { fs.renameSync(tmp, file); }
    catch { rawWrite(file, text, 'utf-8'); try { fs.unlinkSync(tmp); } catch { /* yoksay */ } }
  };
  fs.readFileSync = function (file, ...rest) {
    if (!managed(file)) return rawRead(file, ...rest);
    let err;
    try { const t = rawRead(file, ...rest); JSON.parse(String(t)); return t; } catch (e) { err = e; }
    const bak = file + '.bak';
    if (validJson(bak)) {
      if (err.code !== 'ENOENT') { try { fs.copyFileSync(file, `${file}.bozuk-${Date.now()}`); } catch { /* yoksay */ } }
      console.warn(`[güvenlik] ${path.basename(file)} okunamadı, yedekten yüklendi.`);
      return rawRead(bak, ...rest);
    }
    throw err;
  };
}

const BK = path.join(DIR, 'yedek');
function snapshot(label) {
  try {
    fs.mkdirSync(BK, { recursive: true });
    const dir = path.join(BK, `${new Date().toISOString().replace(/[:.]/g, '-')}_${label}`);
    fs.mkdirSync(dir);
    for (const f of MANAGED) if (fs.existsSync(f) && validJson(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    const all = fs.readdirSync(BK).sort();
    for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.rmSync(path.join(BK, old), { recursive: true, force: true });
    return dir;
  } catch (e) { console.warn('yedek alınamadı:', e.message); return null; }
}

function createStore(file, defFn) {
  const data = defFn();
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
    for (const k of Object.keys(data)) if (j[k] !== undefined) data[k] = j[k];
  } catch { /* ilk çalıştırma */ }
  let timer = null, dirty = false, lastSaved = null, lastError = null;
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(file, JSON.stringify(data)); lastSaved = Date.now(); lastError = null; }
    catch (e) { dirty = true; lastError = e.message; console.warn(`${path.basename(file)} kaydedilemedi:`, e.message); }
  };
  const touch = () => { dirty = true; if (!timer) { timer = setTimeout(flush, 1500); timer.unref?.(); } };
  return { data, touch, flush, info: () => ({ lastSaved, lastError, dirty }) };
}

const P = createStore(path.join(DIR, 'rinae-plus.json'), () => ({
  supers: [],
  maint: { on: false, since: 0, etaAt: 0, reason: '', by: null },
  emoji: '✅',
  guilds: {},
  errors: [],
  restarts: 0,
  pending: null,
}));
const S = createStore(path.join(DIR, 'rinae-sozluk.json'), () => ({ words: {} }));

const isCreator = (id) => String(id) === CREATOR_ID;
const isSuper = (id) => id != null && (isCreator(id) || P.data.supers.includes(String(id)));

// =====================================================================
// 2) YARDIMCILAR
// =====================================================================
const fold = (t) => trLower(t).replace(/\u0307/g, '').replace(/â/g, 'a').replace(/î/g, 'i').replace(/û/g, 'u');
const asciiKeep = (s) => fold(s).replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
  .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');
const asciiKey = (s) => asciiKeep(s).replace(/[^a-z0-9]/g, '');
const up = (c) => String(c).toLocaleUpperCase('tr-TR');
const nf = (n) => Number(n).toLocaleString('tr-TR');
const dayKey = (t = Date.now()) => new Date(t + TR).toISOString().slice(0, 10);
const fmtTime = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
const fmtDur = (ms) => {
  const m = Math.max(1, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  return [d ? `${d} gün` : '', h ? `${h} sa` : '', mi || (!d && !h) ? `${mi} dk` : ''].filter(Boolean).join(' ');
};
const lastLetter = (w) => [...fold(w)].pop();
const NO_START = new Set(['ğ']); // bu harfle kelime başlamaz

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  queues.set(key, run);
  run.catch(() => {}).then(() => { if (queues.get(key) === run) queues.delete(key); });
  return run;
}

function pushError(kind, err) {
  const msg = String(err?.stack || err?.message || err).slice(0, 600);
  P.data.errors.push({ t: Date.now(), kind, msg });
  if (P.data.errors.length > 30) P.data.errors.shift();
  P.touch();
}

// =====================================================================
// 3) TDK SÖZLÜK
// =====================================================================
async function inDictionary(word) {
  const key = fold(word);
  const cached = S.data.words[key];
  if (cached !== undefined) return cached;
  if (typeof fetch !== 'function') return null; // Node 18+ gerekir
  let res;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(`https://sozluk.gov.tr/gts?ara=${encodeURIComponent(word)}`, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (RINAE bot)', Accept: 'application/json' },
    });
    if (!r.ok) return null;
    res = await r.json();
  } catch { return null; } finally { clearTimeout(timer); }

  let ok;
  if (Array.isArray(res)) {
    // özel isimler (Ankara vb.) ve tam eşleşmeyenler kabul edilmez
    ok = res.some((e) => String(e.ozel_mi) !== '1' && fold(String(e.madde || '').replace(/\s*\(.*?\)\s*$/, '')) === key);
  } else if (res && res.error) ok = false;
  else return null;
  S.data.words[key] = ok;
  S.touch();
  return ok;
}

const STARTERS = ['elma', 'kitap', 'kalem', 'deniz', 'bahçe', 'çiçek', 'araba', 'bulut', 'ekmek', 'sevgi', 'orman', 'defter',
  'telefon', 'okul', 'pencere', 'dünya', 'yıldız', 'çorba', 'kiraz', 'limon', 'armut', 'zeytin', 'peynir', 'bayram',
  'yağmur', 'bilgisayar', 'müzik', 'çanta', 'gözlük', 'şemsiye', 'uçak', 'vapur', 'çilek', 'portakal', 'bardak', 'ayna',
  'sandalye', 'masa', 'kapı', 'gökyüzü'].filter((w) => !NO_START.has(lastLetter(w)));

// =====================================================================
// 4) ANA MODÜL
// =====================================================================
function init(ctx) {
  const {
    client, CONFIG, commands, actions, HELP_PAGES, ek, postToChannel, say, sendPanel, ev, who, COLORS,
    resolveUserIds, mentionIds, requirePerm, findBannedWord, punishProfanity, isOwnerOf, guildIdOf,
    getRegRecords, getStrikes, flushAll,
  } = ctx;

  process.env.BOT_OWNER_ID = CREATOR_ID; // !bot-stats sahibi
  const uidOf = (m) => String(m.author?.id);
  const G = (gid) => (P.data.guilds[gid] ||= {
    word: { channelId: null, current: null, letter: null, used: [], accepted: 0, notice: false, lastUser: null },
    count: { channelId: null, next: 1, record: 0, total: 0, notice: false },
  });
  const needAdmin = (m) => requirePerm(m, 'Administrator', 'Bu komut sadece sunucu sahibi/yöneticiler içindir.');
  const superOnly = async (m) => {
    if (isSuper(uidOf(m))) return true;
    await m.reply('Bu komut sadece bot yetkililerine açık.');
    return false;
  };
  const normKey = (name) => trLower(name).replace(/\u0307/g, '');

  // ---------- Hata yakalama + güvenli yeniden başlatma ----------
  let restarting = false;
  async function safeRestart(reason, { crash = false, gid = null, channelId = null } = {}) {
    if (restarting) return;
    restarting = true;
    console.log(`[yeniden başlatma] ${reason}`);
    try {
      P.data.restarts++;
      P.data.pending = { reason, at: Date.now(), gid, channelId };
      P.touch();
      if (crash) snapshot('cokme-oncesi'); // diskteki son sağlam hali sakla, sonra kaydet
      try { flushAll(); } catch (e) { console.warn('flushAll:', e.message); }
      P.flush(); S.flush();
      if (!crash) snapshot('yeniden-baslatma');
      try { await client.destroy?.(); } catch { /* yoksay */ }
      await sleep(1200);
      const now = Date.now();
      const hist = String(process.env.RINAE_RESTARTS || '').split(',').map(Number).filter((t) => t && now - t < 10 * 60e3);
      if (crash && hist.length >= 3) { console.error('10 dakikada 3+ çökme: otomatik yeniden başlatma durduruldu.'); process.exit(1); }
      hist.push(now);
      if (process.env.pm_id !== undefined || process.env.RINAE_SUPERVISED === '1') process.exit(crash ? 1 : 0); // pm2 vb. başlatır
      spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], {
        stdio: 'inherit', env: { ...process.env, RINAE_RESTARTS: hist.join(',') },
      }).unref();
      process.exit(0);
    } catch (e) { console.error('safeRestart hatası:', e); process.exit(1); }
  }

  process.on('unhandledRejection', (e) => { pushError('promise', e); console.error('[unhandledRejection]', e); });
  process.on('uncaughtException', (e) => {
    pushError('çökme', e);
    console.error('[uncaughtException]', e);
    safeRestart(`Beklenmeyen hata: ${e?.message || e}`, { crash: true });
  });
  process.on('SIGTERM', () => { try { flushAll(); } catch { /* yoksay */ } P.flush(); S.flush(); process.exit(0); });
  client.on('error', (e) => pushError('client', e));

  client.on('ready', async () => {
    const pn = P.data.pending;
    if (!pn) return;
    P.data.pending = null; P.touch();
    try {
      await actions.log(ev('♻️ Bot yeniden başladı', COLORS.ok, [['Sebep', pn.reason, false], ['Kesinti', fmtDur(Date.now() - pn.at)]]));
      if (pn.gid && pn.channelId) await postToChannel(pn.gid, pn.channelId, { content: '✅ Yeniden başladım, veriler yerinde.' });
    } catch { /* yoksay */ }
  });

  snapshot('baslangic');
  setInterval(() => snapshot('saatlik'), 3600e3).unref?.();

  // ---------- Tepki (emoji) bırakma ----------
  let reactMode = null, reactWarned = false;
  async function react(message, emoji) {
    const gid = guildIdOf(message);
    const e = String(emoji).replace(/^<a?:(.+):(\d+)>$/, '$1:$2');
    const url = `/bot/guilds/${gid}/channels/${message.channelId}/messages/${message.id}/reactions/${encodeURIComponent(e)}`;
    const tries = [
      async () => { if (typeof message.react !== 'function') throw new Error('yok'); await message.react(emoji); },
      async () => { if (typeof message.addReaction !== 'function') throw new Error('yok'); await message.addReaction(emoji); },
      async () => client.rest.request('PUT', `${url}/@me`),
      async () => client.rest.request('PUT', url),
    ];
    const order = reactMode != null ? [reactMode, ...tries.keys()].filter((v, i, a) => a.indexOf(v) === i) : [...tries.keys()];
    for (const i of order) {
      try { await tries[i](); reactMode = i; return true; } catch { /* sıradakini dene */ }
    }
    if (!reactWarned) { reactWarned = true; console.warn('[tepki] Hiçbir yöntem çalışmadı, emoji mesaj olarak yanıtlanacak. !inspect ile message metotlarına bak.'); }
    try { await message.reply(emoji); } catch { /* yoksay */ }
    return false;
  }

  // ---------- Kelime türetmece ----------
  const usedCache = new WeakMap();
  const usedSet = (W) => { let s = usedCache.get(W); if (!s) { s = new Set(W.used); usedCache.set(W, s); } return s; };
  const addUsed = (W, f) => { usedSet(W).add(f); W.used.push(f); };

  function pickStarter(W) {
    const used = usedSet(W);
    const pool = STARTERS.filter((w) => !used.has(fold(w)));
    const list = pool.length ? pool : STARTERS;
    return list[Math.floor(Math.random() * list.length)];
  }
  async function startChain(gid, W, announce) {
    const w = pickStarter(W);
    addUsed(W, fold(w));
    W.current = w; W.letter = lastLetter(w); W.lastUser = null;
    P.touch();
    if (announce && W.channelId) {
      await postToChannel(gid, W.channelId, {
        embeds: [{
          title: '🔤 Kelime Türetmece başladı!',
          description: `İlk kelime: **${w}**\nSıradaki kelime **${up(W.letter)}** harfiyle başlamalı.\nHer mesajda sadece **bir** kelime yaz. Kelimeler TDK sözlüğünden kontrol edilir.`,
          color: COLORS.ok,
        }],
      });
    }
    return w;
  }

  async function handleWord(message, gid, g) {
    const W = g.word;
    const uid = uidOf(message);
    const content = message.content.trim();
    const reject = async (why) => {
      await actions.deleteMessage(message);
      if (W.notice) await postToChannel(gid, W.channelId, { content: `<@${uid}> ${why}` });
      return true;
    };
    if (!W.current) await startChain(gid, W, true);
    if (/\s/.test(content)) return reject('Tek seferde sadece **bir** kelime yazabilirsin.');
    if (!/^\p{L}{2,40}$/u.test(content)) return reject('Sadece harflerden oluşan tek bir kelime yazmalısın.');
    const word = trLower(content);
    const f = fold(word);

    if (CONFIG.profanity.enabled) {
      const bw = findBannedWord(word);
      if (bw) {
        if (await ek.exempt(message)) await actions.deleteMessage(message);
        else await punishProfanity(message, bw);
        return true;
      }
    }
    if ([...f][0] !== W.letter) return reject(`Kelime **${up(W.letter)}** harfiyle başlamalı.`);
    if (usedSet(W).has(f)) return reject('Bu kelime daha önce kullanıldı.');
    const ok = await inDictionary(word);
    if (ok === null) return reject('Sözlüğe şu an ulaşamadım, birazdan tekrar dene.');
    if (!ok) return reject('Bu kelime TDK sözlüğünde bulunamadı.');

    addUsed(W, f);
    W.current = word; W.letter = lastLetter(word); W.accepted++; W.lastUser = uid;
    P.touch();
    await react(message, P.data.emoji);

    if (NO_START.has(W.letter)) {
      const bad = W.letter;
      const nw = await startChain(gid, W, false);
      await postToChannel(gid, W.channelId, {
        content: `**${up(bad)}** harfiyle başlayan kelime olmadığı için yeni bir kelime belirledim: **${nw}**\nSıradaki harf: **${up(W.letter)}**`,
      });
    }
    return true;
  }

  // ---------- Sayı sayma ----------
  async function handleCount(message, gid, g) {
    const C = g.count;
    const c = message.content.trim();
    if (c !== String(C.next)) {
      await actions.deleteMessage(message);
      if (C.notice) await postToChannel(gid, C.channelId, { content: `<@${uidOf(message)}> Sıradaki sayı **${C.next}**. Sadece rakam yazabilirsin.` });
      return true;
    }
    C.next++; C.total++;
    if (C.next - 1 > C.record) C.record = C.next - 1;
    P.touch();
    await react(message, P.data.emoji);
    return true;
  }

  // ---------- Bakım modu ----------
  const MAINT_ALLOWED = new Set(['ping', 'id', 'help', 'yardim', 'yardım']);
  const noticeAt = new Map();
  function etaText(m) {
    if (!m.etaAt) return 'Tahmini süre belirtilmedi.';
    const left = m.etaAt - Date.now();
    if (left <= 0) return 'Tahmini süre aşıldı, çalışmalar kısa süre içinde bitecek.';
    const at = new Date(m.etaAt).toLocaleTimeString('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit' });
    return `Tahmini bitiş: **${at}** (yaklaşık ${fmtDur(left)} sonra)`;
  }
  const maintText = () => `🛠️ RINAE şu an **bakımda**, komutlara yanıt veremiyorum.\n${P.data.maint.reason ? `Sebep: ${P.data.maint.reason}\n` : ''}${etaText(P.data.maint)}`;

  async function gate(message, key) {
    const m = P.data.maint;
    if (!m.on || isSuper(uidOf(message)) || MAINT_ALLOWED.has(key)) return false;
    const uid = uidOf(message);
    if (Date.now() - (noticeAt.get(uid) || 0) > 15_000) {
      noticeAt.set(uid, Date.now());
      await message.reply(maintText());
    }
    return true;
  }

  // ---------- Yanlış komut önerisi ----------
  const HIDDEN = new Set(['tam-yetki', 'bakim', 'bakım', 'yeniden-baslat', 'restart', 'dev', 'sunucular', 'inspect', 'bot-stats', 'oyun-emoji']);
  function suggestCommand(key, superUser) {
    const n = asciiKey(key);
    if (n.length < 3) return null;
    const best = new Map();
    for (const c of Object.keys(commands)) {
      if (HIDDEN.has(c) && !superUser) continue;
      const a = asciiKey(c);
      const cur = best.get(a);
      if (!cur || (/^[a-z0-9-]+$/.test(c) && !/^[a-z0-9-]+$/.test(cur))) best.set(a, c);
    }
    const limit = n.length <= 4 ? 1 : n.length <= 8 ? 2 : 3;
    let pick = null, bd = Infinity;
    for (const [a, c] of best) {
      const d = a === n ? 0 : lev(n, a);
      if (d <= limit && d < Math.max(2, n.length / 2) && (d < bd || (d === bd && Math.abs(a.length - n.length) < Math.abs(asciiKey(pick).length - n.length)))) { pick = c; bd = d; }
    }
    return pick;
  }
  async function unknownCommand(message, key, args) {
    if (!key || !/^[\p{L}\p{N}_-]+$/u.test(key)) return false;
    const s = suggestCommand(key, isSuper(uidOf(message)));
    if (!s) return false;
    const rest = args.length ? ' ' + args.join(' ').slice(0, 200) : '';
    await message.reply(`Böyle bir komut yok. Şunu mu demek istedin: \`${CONFIG.prefix}${s}${rest}\``);
    return true;
  }

  // ---------- Etiketle-sor (veri soruları) ----------
  function botMentioned(message) {
    const me = client.user?.id;
    if (!me) return false;
    if (new RegExp(`<@!?${me}>`).test(message.content)) return true;
    const name = client.user?.username;
    return Boolean(name && new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(message.content));
  }
  async function staffOk(message) {
    return isSuper(uidOf(message)) || isOwnerOf(message) || (await ek.isAdmin(message));
  }
  function loadVeri() {
    try { ek.flush(); return JSON.parse(fs.readFileSync(path.join(DIR, 'veri.json'), 'utf-8')); } catch { return null; }
  }
  function parseRange(t) {
    const now = Date.now();
    const sod = (ts) => Math.floor((ts + TR) / DAY) * DAY - TR;
    const today = sod(now);
    const dow = new Date(now + TR).getUTCDay();
    const weekStart = today - ((dow + 6) % 7) * DAY;
    const ld = new Date(now + TR);
    const y = ld.getUTCFullYear(), mo = ld.getUTCMonth();
    const monthStart = (yy, mm) => Date.UTC(yy, mm, 1) - TR;
    let m;
    if (/\bbugun\b/.test(t)) return { from: today, to: now + 1, label: 'bugün' };
    if (/\bdun\b/.test(t)) return { from: today - DAY, to: today, label: 'dün' };
    if (/gecen hafta/.test(t)) return { from: weekStart - 7 * DAY, to: weekStart, label: 'geçen hafta' };
    if (/bu hafta/.test(t)) return { from: weekStart, to: now + 1, label: 'bu hafta' };
    if (/gecen ay/.test(t)) return { from: monthStart(y, mo - 1), to: monthStart(y, mo), label: 'geçen ay' };
    if (/\bbu ay\b/.test(t)) return { from: monthStart(y, mo), to: now + 1, label: 'bu ay' };
    if ((m = t.match(/son\s+(\d{1,3})\s*(gun|hafta|ay)/))) {
      const days = Number(m[1]) * (m[2] === 'gun' ? 1 : m[2] === 'hafta' ? 7 : 30);
      return { from: today - (days - 1) * DAY, to: now + 1, label: `son ${m[1]} ${m[2] === 'gun' ? 'gün' : m[2]}` };
    }
    if (/son\s+(bir\s+)?hafta/.test(t)) return { from: today - 6 * DAY, to: now + 1, label: 'son 7 gün' };
    if (/son\s+(bir\s+)?ay\b/.test(t)) return { from: today - 29 * DAY, to: now + 1, label: 'son 30 gün' };
    return { from: 0, to: now + 1, label: 'şimdiye kadar', all: true };
  }
  const cap = (s) => s.charAt(0).toLocaleUpperCase('tr-TR') + s.slice(1);

  function sumStat(D, gid, field, r) {
    const a = dayKey(r.from), b = dayKey(r.to - 1);
    let s = 0;
    for (const [k, d] of Object.entries(D.stats?.[gid]?.daily || {})) if (k >= a && k <= b) s += d[field] || 0;
    return s;
  }
  function topUsers(D, gid, r) {
    const a = dayKey(r.from), b = dayKey(r.to - 1), u = {};
    for (const [k, d] of Object.entries(D.stats?.[gid]?.daily || {})) {
      if (k < a || k > b) continue;
      for (const [id, c] of Object.entries(d.u || {})) u[id] = (u[id] || 0) + c;
    }
    return Object.entries(u).sort((x, y) => y[1] - x[1]);
  }

  async function answer(message, gid) {
    const text = message.content.replace(/<@!?&?\d+>/g, ' ').replace(/@\S+/, ' ').replace(/\s+/g, ' ').trim();
    const examples = 'Örnekler:\n• bu hafta kaç kişi başvuru yaptı?\n• bekleyen şikayet var mı?\n• yaklaşan etkinlikler neler?\n• son 7 günde kaç mesaj atıldı?\n• bu ay kaç kişi kayıt oldu?\n• en çok mesaj atan kim?\n• kaç yeni üye katıldı?\n• kelime oyunu nasıl gidiyor?';
    if (!text) return message.reply(`Buyur? Bana sunucu verileriyle ilgili soru sorabilirsin 💖\n${examples}`);
    const D = loadVeri();
    if (!D) return message.reply('Veri dosyasını okuyamadım, birazdan tekrar dene.');
    const t = asciiKeep(text);
    const r = parseRange(t);
    const has = (re) => re.test(t);
    const per = cap(r.label);
    const inR = (ts) => ts >= r.from && ts < r.to;
    const guild = client.guilds?.get(gid);

    if (has(/basvuru/)) {
      const st = has(/bekle|bekliyor/) ? 'pending' : has(/onaylan|kabul/) ? 'approved' : has(/reddedil|\bred\b/) ? 'rejected' : null;
      const typeName = Object.keys(D.apps.types).find((n) => n.length >= 3 && t.includes(asciiKeep(n)));
      const subs = D.apps.subs.filter((s) => s.gid === gid && inR(s.createdAt) && (!st || s.status === st) && (!typeName || s.type === typeName));
      const what = `${typeName ? `**${typeName}** ` : ''}${st ? { pending: 'bekleyen ', approved: 'onaylanan ', rejected: 'reddedilen ' }[st] : ''}başvuru`;
      if (!subs.length) return message.reply(`${per} hiç ${what} yok.`);
      const people = new Set(subs.map((s) => s.userId)).size;
      const c = (x) => subs.filter((s) => s.status === x).length;
      return message.reply(`📋 ${per} **${nf(people)} kişi** ${what} yaptı (toplam ${nf(subs.length)} başvuru).${st ? '' : `\nDurum: ${c('pending')} bekliyor, ${c('approved')} onaylandı, ${c('rejected')} reddedildi.`}`);
    }
    if (has(/sikayet/)) {
      const st = has(/acik|bekle/) ? 'open' : has(/cozul/) ? 'solved' : has(/reddedil|\bret\b/) ? 'rejected' : null;
      const list = D.reports.list.filter((x) => x.gid === gid && inR(x.createdAt) && (!st || x.status === st));
      if (!list.length) return message.reply(`${per} ${st ? { open: 'açık', solved: 'çözülmüş', rejected: 'reddedilmiş' }[st] + ' ' : ''}şikayet yok.`);
      const c = (x) => list.filter((s) => s.status === x).length;
      return message.reply(`🚨 ${per} **${nf(list.length)}** şikayet var: ${c('open')} açık, ${c('solved')} çözüldü, ${c('rejected')} reddedildi.`);
    }
    if (has(/etkinlik|event/)) {
      if (has(/yaklasan|siradaki|ne zaman|planlanan/)) {
        const up5 = D.events.list.filter((e) => e.gid === gid && (e.status === 'upcoming' || e.status === 'started')).sort((a, b) => a.startAt - b.startAt).slice(0, 5);
        if (!up5.length) return message.reply('Yaklaşan etkinlik yok.');
        return message.reply('🎉 Yaklaşan etkinlikler:\n' + up5.map((e) => `• #${e.id} **${e.title}** • ${fmtTime(e.startAt)} • ${e.participants.length} katılımcı`).join('\n'));
      }
      const evs = D.events.list.filter((e) => e.gid === gid && inR(e.startAt));
      const att = D.attendance.filter((a) => a.gid === gid && inR(a.at)).length;
      if (!evs.length && !att) return message.reply(`${per} etkinlik yok.`);
      return message.reply(`🎉 ${per} **${nf(evs.length)}** etkinlik var (${evs.filter((e) => e.status === 'ended').length} tamamlandı, ${evs.filter((e) => e.status === 'cancelled').length} iptal). Toplam **${nf(att)}** katılım kaydı.`);
    }
    if (has(/kelime (oyun|turet)|turetmece/)) {
      const W = P.data.guilds[gid]?.word;
      if (!W?.channelId) return message.reply('Bu sunucuda kelime oyunu kapalı.');
      return message.reply(`🔤 Kelime oyununda şimdiye kadar **${nf(W.accepted)}** kelime kabul edildi. Son kelime: **${W.current ?? '—'}**, sıradaki harf: **${W.letter ? up(W.letter) : '—'}**.`);
    }
    if (has(/sayi (oyun|say)|sayma/)) {
      const C = P.data.guilds[gid]?.count;
      if (!C?.channelId) return message.reply('Bu sunucuda sayı sayma oyunu kapalı.');
      return message.reply(`🔢 Sıradaki sayı **${nf(C.next)}**, rekor **${nf(C.record)}**, şimdiye kadar **${nf(C.total)}** doğru sayı yazıldı.`);
    }
    if (has(/kayit/)) {
      const n = Object.values(getRegRecords()).filter((x) => x.guildId === gid && inR(Date.parse(x.registeredAt))).length;
      return message.reply(`📝 ${per} **${nf(n)}** kişi kayıt oldu.`);
    }
    if (has(/en aktif|en cok mesaj|kim .*(cok|aktif)/)) {
      const top = topUsers(D, gid, r).slice(0, 5);
      if (!top.length) return message.reply(`${per} için mesaj verisi yok.`);
      return message.reply(`🏆 ${per} en aktif üyeler:\n` + top.map(([u, c], i) => `${i + 1}. <@${u}> • ${nf(c)} mesaj`).join('\n'));
    }
    if (has(/yetkili|moderator/)) {
      const rows = Object.entries(D.staff).filter(([k]) => k.startsWith(`${gid}:`))
        .map(([k, s]) => [k.slice(gid.length + 1), s.ban + s.kick + s.mute + s.unmute + s.unban + s.report + s.app + s.role])
        .sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (!rows.length) return message.reply('Henüz kayıtlı yetkili işlemi yok.');
      return message.reply('🛡️ En çok işlem yapan yetkililer (takip başlangıcından beri):\n' + rows.map(([u, n], i) => `${i + 1}. <@${u}> • ${nf(n)} işlem`).join('\n'));
    }
    if (has(/\b(ban|kick|mute|timeout|moderasyon|ceza)/)) {
      return message.reply(`🔨 ${per} komutla yapılan **${nf(sumStat(D, gid, 'mod', r))}** moderasyon işlemi var.`);
    }
    if (has(/sicil|ihlal|kufur|reklam/)) {
      const { strikes, adStrikes } = getStrikes();
      const users = new Set();
      for (const st of [strikes, adStrikes]) for (const k of Object.keys(st)) if (k.startsWith(`${gid}:`)) users.add(k);
      const ids = new Set([...users].map((k) => k.slice(gid.length + 1)));
      return message.reply(`📋 Sicilde ihlali olan **${nf(ids.size)}** kişi var (küfür ihlali: ${nf(Object.keys(strikes).filter((k) => k.startsWith(`${gid}:`)).length)} kişi, reklam: ${nf(Object.keys(adStrikes).filter((k) => k.startsWith(`${gid}:`)).length)} kişi).`);
    }
    if (has(/mesaj/)) return message.reply(`💬 ${per} toplam **${nf(sumStat(D, gid, 'm', r))}** mesaj atıldı.`);
    if (has(/yeni uye|katil|giris|gelen/)) return message.reply(`👋 ${per} **${nf(sumStat(D, gid, 'j', r))}** yeni üye katıldı.`);
    if (has(/uye/)) {
      const n = guild?.memberCount ?? guild?.member_count ?? guild?.members?.size;
      return message.reply(n ? `👥 Sunucuda **${nf(n)}** üye var.` : 'Üye sayısını şu an öğrenemedim.');
    }
    return message.reply(`Bunu tam anlayamadım 🥺 Şunları sorabilirsin:\n${examples}`);
  }

  // ---------- Mesaj kancası (index.js messageCreate başında çağrılır) ----------
  async function beforeMessage(message, isCmd) {
    if (restarting) return true;
    const gid = guildIdOf(message);
    if (!gid) return false;
    const uid = uidOf(message);
    if (isCmd) {
      const raw = message.content.slice(CONFIG.prefix.length).trim().split(/\s+/)[0] || '';
      if (Object.hasOwn(commands, raw.toLowerCase()) || Object.hasOwn(commands, normKey(raw))) return false;
    }
    if (P.data.maint.on && !isSuper(uid)) return false; // bakımda oyunlar ve soru-cevap durur
    if (!isCmd && botMentioned(message)) {
      if (await staffOk(message)) {
        try { await answer(message, gid); } catch (e) { pushError('soru-cevap', e); await message.reply('Verilere bakarken bir sorun oluştu.'); }
        return true;
      }
      return false;
    }
    const g = P.data.guilds[gid];
    if (!g) return false;
    if (g.word?.channelId && g.word.channelId === message.channelId) return enqueue(`w:${gid}`, () => handleWord(message, gid, g));
    if (g.count?.channelId && g.count.channelId === message.channelId) return enqueue(`c:${gid}`, () => handleCount(message, gid, g));
    return false;
  }

  // =====================================================================
  // KOMUTLAR
  // =====================================================================
  const onoff = (v) => (['ac', 'aç', 'on', 'acik', 'açık'].includes(trLower(v)) ? true : ['kapat', 'off', 'kapali', 'kapalı'].includes(trLower(v)) ? false : null);
  const chRef = (id) => (id ? `<#${id}>` : 'Kapalı');

  Object.assign(commands, {
    // ----- Tam yetki (sadece sahip) -----
    async 'tam-yetki'(message, args) {
      if (!isCreator(uidOf(message))) return message.reply('Bu komut sadece RINAE\'nin sahibine özel.');
      const sub = trLower(args[0]);
      if (!sub || sub === 'liste') {
        return message.reply(`👑 Sahip: \`${CREATOR_ID}\`\nTam yetkili kullanıcılar: ${P.data.supers.length ? P.data.supers.map((i) => `<@${i}>`).join(' ') : 'yok'}`);
      }
      const id = resolveUserIds(message, args[1])[0];
      if (!id) return message.reply('Kullanım: !tam-yetki <ver|al|liste> <kullanıcı>');
      if (sub === 'ver') {
        if (isCreator(id)) return message.reply('Zaten sahibimsin 👑');
        if (!P.data.supers.includes(id)) P.data.supers.push(id);
      } else if (sub === 'al' || sub === 'sil') {
        P.data.supers = P.data.supers.filter((x) => x !== id);
      } else return message.reply('Kullanım: !tam-yetki <ver|al|liste> <kullanıcı>');
      P.touch(); P.flush();
      await actions.log(ev('👑 Tam yetki değişti', COLORS.warn, [['Kullanıcı', who(id)], ['İşlem', sub === 'ver' ? 'Verildi' : 'Alındı'], ['Sahip', who(uidOf(message))]]));
      return message.reply(sub === 'ver' ? `<@${id}> artık botun tüm komutlarında ve sunucularında tam yetkili.` : `<@${id}> kişisinin tam yetkisi alındı.`);
    },

    // ----- Oyun emojisi (evrensel, sadece sahip) -----
    async 'oyun-emoji'(message, args) {
      if (!isCreator(uidOf(message))) return message.reply('Bu komut sadece RINAE\'nin sahibine özel.');
      const e = (args[0] || '').trim();
      if (!e || e.length > 64) return message.reply(`Kullanım: !oyun-emoji <emoji>\nŞu anki emoji: ${P.data.emoji}`);
      P.data.emoji = e; P.touch(); P.flush();
      return message.reply(`Kabul edilen kelime/sayılara artık şu emojiyi bırakacağım (tüm sunucularda): ${e}`);
    },

    // ----- Kelime türetmece -----
    async 'kelime-oyunu'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const g = G(gid), W = g.word;
      const sub = trLower(args[0]);
      if (sub === 'kanal') {
        if (g.count.channelId === message.channelId) return message.reply('Bu kanal sayı sayma oyunu için ayarlı, başka bir kanal seç.');
        W.channelId = message.channelId; P.touch();
        if (!W.current) await startChain(gid, W, true);
        else await postToChannel(gid, W.channelId, { content: `🔤 Kelime oyunu bu kanalda devam ediyor! Son kelime: **${W.current}**, sıradaki harf: **${up(W.letter)}**` });
        return;
      }
      if (sub === 'kapat') { W.channelId = null; P.touch(); return message.reply('Kelime oyunu kapatıldı (kullanılan kelimeler saklanıyor).'); }
      if (sub === 'sifirla' || sub === 'sıfırla') {
        W.used = []; usedCache.delete(W); W.accepted = 0; W.current = null; P.touch();
        if (W.channelId) await startChain(gid, W, true);
        return message.reply('Kelime oyunu sıfırlandı.');
      }
      if (sub === 'atla') {
        if (!W.channelId) return message.reply('Önce kanalı ayarla: !kelime-oyunu kanal');
        const nw = await startChain(gid, W, false);
        return postToChannel(gid, W.channelId, { content: `🔄 Yeni kelime: **${nw}** • Sıradaki harf: **${up(W.letter)}**` });
      }
      if (sub === 'uyari' || sub === 'uyarı') {
        const v = onoff(args[1]);
        if (v === null) return message.reply('Kullanım: !kelime-oyunu uyari <ac|kapat>  (silinen mesajın sebebini yazar)');
        W.notice = v; P.touch();
        return message.reply(`Hatalı kelime bildirimi: ${v ? 'açık' : 'kapalı'}`);
      }
      return sendPanel(message, { embeds: [ev('🔤 Kelime Türetmece', COLORS.main, [
        ['Kanal', chRef(W.channelId)], ['Son kelime', W.current ?? '—'], ['Sıradaki harf', W.letter ? up(W.letter) : '—'],
        ['Kabul edilen', nf(W.accepted)], ['Kullanılan kelime', nf(W.used.length)], ['Hata bildirimi', W.notice ? 'Açık' : 'Kapalı'],
        ['Komutlar', '`kanal` • `kapat` • `sifirla` • `atla` • `uyari ac|kapat`', false],
      ])] });
    },

    // ----- Sayı sayma -----
    async 'sayi-oyunu'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const g = G(gid), C = g.count;
      const sub = trLower(args[0]);
      if (sub === 'kanal') {
        if (g.word.channelId === message.channelId) return message.reply('Bu kanal kelime oyunu için ayarlı, başka bir kanal seç.');
        C.channelId = message.channelId; P.touch();
        return postToChannel(gid, C.channelId, { content: `🔢 Sayı sayma oyunu başladı! Sıradaki sayı: **${C.next}**\nSadece rakam yazabilirsiniz.` });
      }
      if (sub === 'kapat') { C.channelId = null; P.touch(); return message.reply('Sayı sayma oyunu kapatıldı.'); }
      if (sub === 'sifirla' || sub === 'sıfırla') {
        C.next = 1; P.touch();
        if (C.channelId) await postToChannel(gid, C.channelId, { content: '🔢 Sayaç sıfırlandı! Sıradaki sayı: **1**' });
        return message.reply('Sayaç sıfırlandı (rekor korunuyor).');
      }
      if (sub === 'uyari' || sub === 'uyarı') {
        const v = onoff(args[1]);
        if (v === null) return message.reply('Kullanım: !sayi-oyunu uyari <ac|kapat>');
        C.notice = v; P.touch();
        return message.reply(`Hatalı sayı bildirimi: ${v ? 'açık' : 'kapalı'}`);
      }
      return sendPanel(message, { embeds: [ev('🔢 Sayı Sayma', COLORS.main, [
        ['Kanal', chRef(C.channelId)], ['Sıradaki sayı', nf(C.next)], ['Rekor', nf(C.record)], ['Toplam doğru', nf(C.total)],
        ['Komutlar', '`kanal` • `kapat` • `sifirla` • `uyari ac|kapat`', false],
      ])] });
    },

    // ----- Çoklu sunucu: bu sunucunun ayarları -----
    async 'sunucu-ayar'(message) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const g = G(gid);
      const guild = client.guilds?.get(gid);
      return sendPanel(message, { embeds: [ev(`⚙️ ${guild?.name ?? 'Sunucu'} Ayarları`, COLORS.main, [
        ['🔤 Kelime oyunu', chRef(g.word.channelId)], ['🔢 Sayı oyunu', chRef(g.count.channelId)],
        ['🎁 Oyun emojisi', P.data.emoji],
        ['Not', 'Oyun ayarları her sunucuda ayrı tutulur. Başvuru, şikayet, etkinlik, hoş geldin ve istatistikler zaten sunucuya göre ayrıdır.', false],
      ])] });
    },
    async sunucular(message) {
      if (!(await superOnly(message))) return;
      const list = [...(client.guilds?.values?.() ?? [])];
      if (!list.length) return message.reply('Sunucu listesi alınamadı.');
      return sendPanel(message, { embeds: [ev(`🌐 Sunucular (${list.length})`, COLORS.main, list.slice(0, 20).map((s) => {
        const g = P.data.guilds[s.id];
        return [`${s.name ?? 'Sunucu'}`, `\`${s.id}\`\n👥 ${s.memberCount ?? s.member_count ?? '?'}\n🔤 ${g?.word?.channelId ? '✅' : '—'} 🔢 ${g?.count?.channelId ? '✅' : '—'}`];
      }))] });
    },

    // ----- Bakım modu -----
    async bakim(message, args) {
      if (!(await superOnly(message))) return;
      const m = P.data.maint;
      const sub = trLower(args[0]);
      const mins = /^\d+$/.test(args[1] ?? '') ? Number(args[1]) : 0;
      if (sub === 'ac' || sub === 'aç') {
        const reason = args.slice(mins ? 2 : 1).join(' ').slice(0, 200);
        P.data.maint = { on: true, since: Date.now(), etaAt: mins ? Date.now() + mins * 60000 : 0, reason, by: uidOf(message) };
        P.touch(); P.flush();
        await actions.log(ev('🛠️ Bakım modu AÇILDI', COLORS.warn, [['Yetkili', who(uidOf(message))], ['Süre', mins ? `${mins} dk` : 'belirsiz'], ['Sebep', reason || '—', false]]));
        return message.reply(`Bakım modu açıldı. ${etaText(P.data.maint)}\nKapatmak için: !bakim kapat`);
      }
      if (sub === 'kapat') {
        if (!m.on) return message.reply('Bot zaten bakımda değil.');
        P.data.maint = { on: false, since: 0, etaAt: 0, reason: '', by: null };
        P.touch(); P.flush();
        await actions.log(ev('✅ Bakım modu KAPANDI', COLORS.ok, [['Yetkili', who(uidOf(message))], ['Süre', fmtDur(Date.now() - m.since)]]));
        return message.reply('Bakım modu kapatıldı, komutlar tekrar açık.');
      }
      if (sub === 'sure' || sub === 'süre') {
        if (!m.on || !mins) return message.reply('Kullanım: !bakim sure <dakika>  (bakım açıkken)');
        m.etaAt = Date.now() + mins * 60000; P.touch();
        return message.reply(`Tahmini süre güncellendi. ${etaText(m)}`);
      }
      return message.reply(m.on
        ? `🛠️ Bakım **açık** (${fmtDur(Date.now() - m.since)} önce başladı).\n${m.reason ? `Sebep: ${m.reason}\n` : ''}${etaText(m)}`
        : 'Bakım modu kapalı.\nKullanım: !bakim ac [dakika] [sebep] • !bakim kapat • !bakim sure <dakika>');
    },

    // ----- Güvenli yeniden başlatma -----
    async 'yeniden-baslat'(message) {
      if (!(await superOnly(message))) return;
      await message.reply('♻️ Veriler kaydediliyor ve yedekleniyor, birkaç saniye içinde yeniden başlıyorum. Bu sırada gelen komutlar yok sayılır.');
      return safeRestart(`Elle yeniden başlatıldı (${uidOf(message)})`, { gid: guildIdOf(message), channelId: message.channelId });
    },

    // ----- Geliştirici konsolu -----
    async dev(message, args) {
      if (!(await superOnly(message))) return;
      const sub = trLower(args[0]);
      if (sub === 'yedek') {
        P.flush(); S.flush();
        try { flushAll(); } catch { /* yoksay */ }
        const d = snapshot('manuel');
        return message.reply(d ? `Yedek alındı: \`${path.basename(d)}\`` : 'Yedek alınamadı, konsola bak.');
      }
      if (sub === 'hatalar') {
        const errs = P.data.errors.slice(-8).reverse();
        if (!errs.length) return message.reply('Kayıtlı hata yok 🎉');
        return message.reply(errs.map((e) => `**${fmtTime(e.t)}** [${e.kind}]\n\`\`\`${e.msg.slice(0, 300)}\`\`\``).join('\n').slice(0, 1900));
      }
      const mem = process.memoryUsage();
      const ping = client.ws?.ping ?? client.ping;
      const fileInfo = (f) => {
        try {
          const st = fs.statSync(f);
          return `${validJson(f) ? '✅' : '⚠️ BOZUK'} ${(st.size / 1024).toFixed(1)} KB • ${fmtTime(st.mtimeMs)}`;
        } catch { return '➖ henüz yok'; }
      };
      let backups = 0, lastBackup = '—';
      try { const l = fs.readdirSync(BK).sort(); backups = l.length; lastBackup = l.at(-1) ?? '—'; } catch { /* yok */ }
      const stores = [['rinae-plus', P.info()], ['sözlük', S.info()]]
        .map(([n, i]) => `${n}: ${i.lastError ? `❌ ${i.lastError}` : i.lastSaved ? `kaydedildi ${fmtTime(i.lastSaved)}` : 'değişiklik yok'}${i.dirty ? ' (bekliyor)' : ''}`).join('\n');
      const games = Object.values(P.data.guilds).filter((g) => g.word?.channelId || g.count?.channelId).length;
      const lastErr = P.data.errors.at(-1);
      return sendPanel(message, { embeds: [ev('🧑‍💻 Geliştirici Konsolu', COLORS.main, [
        ['🟢 Bağlantı', client.user ? `Bağlı (${client.user.username})` : '❌ Bağlı değil'],
        ['🏓 Gecikme', typeof ping === 'number' ? `${Math.round(ping)} ms` : 'Bilinmiyor'],
        ['⏱️ Çalışma süresi', `${fmtDur(process.uptime() * 1000)}\nBaşlangıç: ${fmtTime(Date.now() - process.uptime() * 1000)}`],
        ['🗄️ Veri dosyaları (JSON)', MANAGED.map((f) => `${path.basename(f)}: ${fileInfo(f)}`).join('\n'), false],
        ['💾 Kayıt durumu', stores, false],
        ['📦 Yedekler', `${backups} adet\nSon: ${lastBackup}`],
        ['🧠 Bellek', `${(mem.rss / 1048576).toFixed(0)} MB (heap ${(mem.heapUsed / 1048576).toFixed(0)} MB)`],
        ['🌐 Sunucu', client.guilds?.size ?? '?'],
        ['🎮 Aktif oyun sunucusu', games],
        ['🛠️ Bakım', P.data.maint.on ? 'AÇIK' : 'Kapalı'],
        ['♻️ Yeniden başlatma', `${P.data.restarts} kez`],
        ['⚠️ Son hata', lastErr ? `${fmtTime(lastErr.t)} [${lastErr.kind}]\n${lastErr.msg.split('\n')[0].slice(0, 150)}` : 'Yok', false],
        ['Node', `${process.version} • ${process.platform}`],
      ], 'Alt komutlar: `!dev hatalar` • `!dev yedek`')] });
    },
  });
  commands['bakım'] = commands.bakim;
  commands.restart = commands['yeniden-baslat'];

  // ---------- Yardım sayfaları ----------
  const oldC = HELP_PAGES.community;
  HELP_PAGES.community = () => {
    const p = oldC ? oldC() : { title: '🎪 Topluluk Komutları', color: COLORS.ok, fields: [] };
    p.fields.push(
      { name: '🔤 Kelime türetmece', value: '`!kelime-oyunu` kanal • kapat • sifirla • atla • uyari ac|kapat\nTek kelime, TDK sözlüğü, son harfle devam.', inline: false },
      { name: '🔢 Sayı sayma', value: '`!sayi-oyunu` kanal • kapat • sifirla • uyari ac|kapat', inline: false },
      { name: '🏷️ Etiketle-sor', value: 'Yetkililer RINAE\'yi etiketleyip sorabilir:\n`@RINAE bu hafta kaç kişi başvuru yaptı?`', inline: false },
      { name: '⚙️ Sunucu', value: '`!sunucu-ayar` bu sunucunun oyun ayarları', inline: false },
    );
    return p;
  };
  const oldS = HELP_PAGES.stats;
  HELP_PAGES.stats = () => {
    const p = oldS ? oldS() : { title: '📊 İstatistik & Yönetim', color: COLORS.main, fields: [] };
    p.fields.push({ name: '🤖 Bot yetkilileri', value: '`!bakim` • `!yeniden-baslat` • `!dev` • `!sunucular` • `!tam-yetki` • `!oyun-emoji`', inline: false });
    return p;
  };

  return {
    isSuper, isCreator, isRestarting: () => restarting, beforeMessage, gate, unknownCommand, normKey,
    flush: () => { P.flush(); S.flush(); },
  };
}

module.exports = { init, isSuper, CREATOR_ID };
