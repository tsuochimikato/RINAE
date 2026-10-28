// RINAE Aile Sistemi: evlilik, boşanma, evlat edinme ve soy ağacı (görselli)
// Komutlar: !marry/!evlen  !divorce/!bosan  !anlasmali-bosan  !adopt/!evlatedin  !adopt me <kullanıcı>  !disown/!evlat-reddet <kullanıcı> [anlasmali]  !aile [kullanıcı]
// Ekonomi bağlantısı: tek taraflı boşanma ve evlat reddi NAFAKA gerektirir (ayrılmak isteyen öder). İki taraf anlaşırsa (anlaşmalı) nafaka yoktur.
// Nafaka için rinae-ekonomi.js yüklü olmalı; yoksa bu modül eskisi gibi ücretsiz çalışır.
// Veriler aile.json dosyasında tutulur. AİLE GLOBALDİR: evlilik ve soy ağacı botun bulunduğu tüm sunucularda ortaktır.
// Eski sunucu bazlı veri ilk açılışta otomatik birleştirilir (yedek: aile.sunucu-bazli-yedek.json).
// Görsel için: npm install @napi-rs/canvas  ve aile-gorsel.js aynı klasörde olmalı.
// Görseli kapatmak için: $env:AILE_GORSEL="0"
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'aile.json');
const LEGACY_BACKUP = path.join(__dirname, 'aile.sunucu-bazli-yedek.json'); // global yapıya geçmeden önceki ham veri
const TTL = 10 * 60 * 1000; // teklifler 10 dakika geçerli
const MAX_PARENTS = 2;
const GORSEL_ACIK = process.env.AILE_GORSEL !== '0';

// ---- Nafaka ayarları ----
// Tutar = ödeyenin bakiyesinin pct oranı, en az min, en fazla max. Her durumda ödeyenin bakiyesini aşamaz
// (parası azsa elindekinin tamamı; böylece fakir biri evliliğe mahkum kalmaz).
const FEE_SPOUSE = { pct: 0.20, min: 250, max: 50000 }; // boşanma: ayrılmak isteyen -> eşi
const FEE_CHILD = { pct: 0.05, min: 100, max: 25000 };  // evlat reddi: ebeveyn -> evladı
const AGREED_WORDS = ['anlasmali', 'anlaşmalı', 'anlasmalı', 'anlaşmali'];

function init(ctx) {
  const { client, commands, postToChannel, makeRow, respondUpdate, respondPrivate, guildIdOf, cleanId, mentionIds, HELP_PAGES } = ctx;
  const COLORS = ctx.COLORS || { main: 0x5865f2, ok: 0x57f287, bad: 0xed4245, warn: 0xfee75c };
  const PINK = 0xff7eb6;

  // Görsel modülü yoksa (paket kurulu değilse) bot yine çalışır, metin ağaca döner
  let renderTree = null;
  if (GORSEL_ACIK) {
    try { ({ renderTree } = require('./aile-gorsel')); }
    catch (e) { console.warn('[aile] Görsel kapalı (metin ağaç kullanılacak):', e.message); }
  }

  // ---------- Veri ----------
  const emptyFam = () => ({ spouse: {}, parents: {}, since: {} });
  function load() {
    for (const f of [FILE, FILE + '.bak']) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (!j || typeof j !== 'object') continue;
        if (j.fam) return { db: { fam: { ...emptyFam(), ...j.fam } }, legacy: null };
        if (j.guilds) {
          try { fs.copyFileSync(f, LEGACY_BACKUP); } catch (e) { console.warn('[aile] eski veri yedeği alınamadı:', e.message); }
          return { db: { fam: emptyFam() }, legacy: j.guilds };
        }
      } catch { /* sıradaki */ }
    }
    return { db: { fam: emptyFam() }, legacy: null };
  }
  const loaded = load();
  const DB = loaded.db;
  function save() {
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB));
      if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* yoksay */ } }
      fs.renameSync(tmp, FILE);
    } catch (err) { console.warn('aile.json kaydedilemedi:', err.message); }
  }
  // Aile artık sunucudan bağımsız: gid parametresi geriye dönük uyumluluk için duruyor, kullanılmaz
  const G = () => DB.fam;
  const parentsOf = (g, u) => g.parents[u] || [];
  const childrenOf = (g, u) => Object.entries(g.parents).filter(([, ps]) => ps.includes(u)).map(([c]) => c);
  const kidsOf = (g, u) => {
    const set = new Set(childrenOf(g, u));
    const s = g.spouse[u];
    if (s) for (const c of childrenOf(g, s)) set.add(c);
    set.delete(u);
    return [...set];
  };
  function ancestors(g, u) {
    const seen = new Set(), stack = [u];
    while (stack.length) {
      for (const p of parentsOf(g, stack.pop())) if (!seen.has(p)) { seen.add(p); stack.push(p); }
    }
    return seen;
  }
  // evlenmesi uygun olmayan akrabalık: ebeveyn-çocuk ve kardeş
  const related = (g, a, b) => {
    const pa = parentsOf(g, a), pb = parentsOf(g, b);
    return pa.includes(b) || pb.includes(a) || pa.some((x) => pb.includes(x));
  };
  function adoptError(g, parent, child) {
    if (parent === child) return 'Kendini evlat edinemezsin 😅';
    if (parentsOf(g, child).length >= MAX_PARENTS) return `<@${child}> zaten ${MAX_PARENTS} ebeveyne sahip, bir kişinin en fazla ${MAX_PARENTS} ebeveyni olabilir.`;
    if (parentsOf(g, child).includes(parent)) return 'Bu kişi zaten ailende, ebeveyn-çocuk bağı var 💞';
    if (g.spouse[parent] === child) return 'Eşini evlat edinemezsin 😅';
    if (ancestors(g, parent).has(child)) return 'Kendi büyüklerini evlat edinemezsin 😅';
    return null;
  }

  // ---------- Eski sunucu bazlı veriyi global yapıya taşı ----------
  // Kurallar: ebeveyn bağları birleştirilir (en fazla 2 ebeveyn, döngü/akrabalık kuralları korunur),
  // evlilikler en eski tarihliden başlayarak eklenir; bir kişi iki sunucuda farklı kişilerle evliyse ilk (en eski) evlilik kalır.
  if (loaded.legacy) {
    const g = DB.fam;
    let skippedP = 0, skippedM = 0;
    const marriages = [];
    for (const gg of Object.values(loaded.legacy)) {
      for (const [child, ps] of Object.entries(gg?.parents || {})) {
        for (const p of ps) {
          if (parentsOf(g, child).includes(p)) continue;
          if (adoptError(g, p, child)) { skippedP++; continue; }
          (g.parents[child] ||= []).push(p);
        }
      }
      const seen = new Set();
      for (const [a, b] of Object.entries(gg?.spouse || {})) {
        if (seen.has(a)) continue;
        seen.add(a); seen.add(b);
        marriages.push({ a, b, since: gg.since?.[a] ?? gg.since?.[b] ?? 0 });
      }
    }
    marriages.sort((x, y) => x.since - y.since);
    for (const m of marriages) {
      if (g.spouse[m.a] === m.b) continue; // aynı çift iki sunucuda da evliydi
      if (m.a === m.b || g.spouse[m.a] || g.spouse[m.b] || related(g, m.a, m.b)) { skippedM++; continue; }
      g.spouse[m.a] = m.b; g.spouse[m.b] = m.a;
      g.since[m.a] = g.since[m.b] = m.since || Date.now();
    }
    save();
    console.log(`[aile] sunucu bazlı veri global yapıya taşındı (${Object.keys(g.spouse).length / 2} evlilik, ${Object.keys(g.parents).length} evlat). Çakışma nedeniyle atlanan: ${skippedM} evlilik, ${skippedP} ebeveyn bağı. Yedek: ${path.basename(LEGACY_BACKUP)}`);
  }

  // ---------- Yardımcılar ----------
  const uidOf = (m) => String(m.author?.id);
  function targetOf(message, raw) {
    if (!raw) return null;
    const m = String(raw).includes('<@') ? mentionIds(message) : [];
    const id = String(m[0] ?? cleanId(raw));
    return /^\d{1,25}$/.test(id) ? id : null;
  }
  const botId = () => String(client.user?.id ?? '');

  // ---------- Ekonomi bağlantısı ----------
  const eco = () => globalThis.__rinaeEconomy || null;
  const fm = (n) => (eco() ? eco().fmt(n) : String(n));
  // Ödeyenin şu anki bakiyesine göre nafaka tutarını hesaplar
  function quoteFee(payer, cfg) {
    const e = eco();
    if (!e) return { enabled: false, amount: 0 };
    const bal = e.balance(payer);
    const raw = Math.min(cfg.max, Math.max(cfg.min, Math.round(bal * cfg.pct)));
    return { enabled: true, amount: Math.min(raw, bal), bal };
  }
  // Nafakayı öder. Ekonomi yoksa ya da tutar 0 ise ödeme yapmadan ok döner.
  function payFee(from, to, amount) {
    const e = eco();
    if (!e || !(amount > 0)) return { ok: true, paid: 0 };
    const r = e.transfer(from, to, amount);
    return r.ok ? { ok: true, paid: amount } : { ok: false, paid: 0 };
  }
  const cooldown = new Map();
  const onCooldown = (key) => {
    const now = Date.now();
    if (now - (cooldown.get(key) || 0) < 30_000) return true;
    cooldown.set(key, now);
    return false;
  };

  // ---------- Kullanıcı adı / avatar (Jubbio) ----------
  const infoCache = new Map();
  let nameWarned = false;
  async function userInfo(gid, id) {
    const key = `${gid}:${id}`;
    const hit = infoCache.get(key);
    if (hit && Date.now() - hit.t < (hit.v.ok ? 5 * 60_000 : 30_000)) return hit.v;
    let v = { name: 'Bilinmeyen kullanıcı', avatar: null, ok: false };
    let m = null;
    try {
      const guild = client.guilds?.get?.(gid);
      m = guild?.members?.get?.(id) ?? guild?.members?.cache?.get?.(id) ?? null;
      if (!m && typeof client.rest?.getMember === 'function') m = await client.rest.getMember(gid, id);
    } catch { /* aşağıda varsayılan kalır */ }
    if (!m) { // aile global olduğu için kişi bu sunucuda olmayabilir: botun diğer sunucularına da bak
      try {
        const all = client.guilds?.values?.() ?? client.guilds?.cache?.values?.() ?? [];
        for (const gg of all) { m = gg?.members?.get?.(id) ?? gg?.members?.cache?.get?.(id) ?? null; if (m) break; }
        if (!m) m = client.users?.get?.(id) ?? client.users?.cache?.get?.(id) ?? null;
      } catch { /* varsayılan kalır */ }
    }
    const u = m?.user ?? m?.member?.user ?? m;
    const name = m?.nick ?? m?.nickname ?? m?.displayName ?? u?.display_name ?? u?.displayName
      ?? u?.global_name ?? u?.globalName ?? u?.username ?? u?.name;
    let avatar = u?.avatarURL ?? u?.avatar_url ?? null;
    try { if (typeof avatar === 'function') avatar = avatar.call(u); } catch { avatar = null; }
    if (!avatar && typeof u?.displayAvatarURL === 'function') { try { avatar = u.displayAvatarURL(); } catch { avatar = null; } }
    if (typeof avatar !== 'string' || !/^https?:\/\//i.test(avatar)) avatar = null;
    if (name) v = { name: String(name), avatar, ok: true };
    else if (!nameWarned) {
      nameWarned = true;
      console.warn('[aile] Kullanıcı adı okunamadı. getMember alanları:', Object.keys(m || {}), '| user alanları:', Object.keys(u || {}));
    }
    infoCache.set(key, { t: Date.now(), v });
    return v;
  }
  const nf = (n) => Number(n).toLocaleString('tr-TR');
  const esc = (s) => String(s).replace(/([*_~`|\\])/g, '\\$1');
  // Embed içinde <@id> etiketleri çözülmediği için metindeki etiketleri kalın kullanıcı adına çevirir.
  // Adı bulunamayan kişinin etiketi olduğu gibi kalır.
  async function named(gid, text) {
    const s = String(text ?? '');
    const ids = [...new Set([...s.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]))];
    if (!ids.length) return s;
    const names = new Map();
    await Promise.all(ids.map(async (id) => {
      try { const v = await userInfo(gid, id); if (v.ok) names.set(id, v.name); } catch { /* etiket kalır */ }
    }));
    return s.replace(/<@!?(\d+)>/g, (all, id) => (names.has(id) ? `**${esc(names.get(id))}**` : all));
  }

  // kind: m=evlilik, a=evlat edinme (gönderen ebeveyn), p=evlat edinilme isteği (gönderen çocuk), d=boşanma onayı (nafakalı), r=evlat reddetme onayı (nafakalı),
//       x=anlaşmalı boşanma teklifi (eş karar verir), s=anlaşmalı evlat bağı sonlandırma teklifi (evlat karar verir). extra = nafaka tutarı (d, r)
  async function propose(message, gid, kind, from, to, { title, text, yes = '✅ Kabul Et', no = '❌ Reddet', mention, color = PINK, extra = null }) {
    const t = Date.now().toString(36);
    const desc = await named(gid, text);
    const id = (v) => `fm:${kind}:${v}:${from}:${to}:${t}${extra != null ? `:${extra}` : ''}`;
    const ok = await postToChannel(gid, message.channelId, {
      content: `<@${mention}>`,
      embeds: [{ title, description: desc, color, footer: { text: 'Bu teklif 10 dakika geçerli' } }],
      components: [makeRow([{ id: id('y'), label: yes, style: kind === 'd' || kind === 'r' ? 'Danger' : 'Success' }, { id: id('n'), label: no, style: kind === 'd' || kind === 'r' ? 'Secondary' : 'Danger' }])],
    });
    if (!ok) await message.reply('Teklifi gönderemedim, birazdan tekrar dene.');
  }

  // ---------- Soy ağacı (metin) ----------
  // nameOf verilmezse etiket (<@id>) yazar, verilirse düz kullanıcı adı yazar
  function render(g, root, nameOf = (u) => `<@${u}>`) {
    const N = nameOf;
    const WS = (u) => (g.spouse[u] ? `${N(u)} 💍 ${N(g.spouse[u])}` : N(u));
    const lines = [`👤 **${N(root)}**`];
    const sp = g.spouse[root];
    if (sp) {
      const ts = g.since[root];
      lines.push(`💍 Eş: ${N(sp)}${ts ? ` • ${new Date(ts).toLocaleDateString('tr-TR')} tarihinden beri` : ''}`);
    }
    const ps = parentsOf(g, root);
    if (ps.length) {
      lines.push('', '👪 **Ebeveynler**');
      ps.forEach((p, i) => {
        const last = i === ps.length - 1;
        lines.push(`${last ? '┗' : '┣'} ${WS(p)}`);
        const gp = parentsOf(g, p);
        if (gp.length) lines.push(`${last ? '\u2003' : '┃'} ┗ ⬆️ ${gp.map(N).join(' • ')}`);
      });
    }
    const sibs = [...new Set(ps.flatMap((p) => childrenOf(g, p)))].filter((x) => x !== root);
    if (sibs.length) {
      lines.push('', '🧒 **Kardeşler**');
      sibs.forEach((s, i) => lines.push(`${i === sibs.length - 1 ? '┗' : '┣'} ${WS(s)}`));
    }
    const seen = new Set([root]);
    const walk = (u, depth, prefix) => {
      const cs = kidsOf(g, u).filter((c) => !seen.has(c));
      cs.forEach((c, i) => {
        seen.add(c);
        const last = i === cs.length - 1;
        lines.push(`${prefix}${last ? '┗' : '┣'} ${WS(c)}`);
        if (depth < 3) walk(c, depth + 1, prefix + (last ? '\u2003' : '┃ '));
      });
    };
    const kids = kidsOf(g, root);
    if (kids.length) {
      lines.push('', '👶 **Çocuklar**');
      walk(root, 1, '');
    }
    return { lines, empty: !sp && !ps.length && !kids.length };
  }

  // ---------- Komutlar ----------
  async function marry(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const a = uidOf(message), b = targetOf(message, args[0]);
    const g = G(gid);
    if (!b) return message.reply('Kullanım: !marry <kullanıcı>  (ya da !evlen <kullanıcı>)');
    if (b === a) return message.reply('Kendinle evlenemezsin 😅');
    if (b === botId()) return message.reply('Ben evlenmem ki, ben sadece botum 🥺');
    if (g.spouse[a]) return message.reply(`Zaten <@${g.spouse[a]}> ile evlisin 💍 Önce !divorce ile ayrılmalısın.`);
    if (g.spouse[b]) return message.reply(`<@${b}> zaten evli, teklifin otomatik olarak reddedildi 💔`);
    if (related(g, a, b)) return message.reply('Aile bireyinle evlenemezsin 😅');
    if (onCooldown(`m:${a}:${b}`)) return message.reply('Bu kişiye az önce teklif ettin, biraz bekle 💌');
    return propose(message, gid, 'm', a, b, {
      mention: b, title: '💍 Evlilik Teklifi',
      text: `<@${a}> sana evlenme teklif ediyor <@${b}>!\nKabul edersen evli olursunuz.`,
    });
  }

  async function divorce(message) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const a = uidOf(message), g = G(gid), s = g.spouse[a];
    if (!s) return message.reply('Zaten evli değilsin 🙂');
    const fee = quoteFee(a, FEE_SPOUSE);
    const feeText = fee.amount > 0
      ? `\n\n💸 **Nafaka:** ${fm(fee.amount)} bakiyenden <@${s}> kişisine ödenecek.\n🤝 İkiniz de ayrılmak istiyorsanız nafakasız yol: \`!anlasmali-bosan\``
      : '';
    return propose(message, gid, 'd', a, s, {
      mention: a, title: '💔 Boşanma Onayı', color: COLORS.warn, extra: fee.amount,
      text: `<@${a}>, <@${s}> ile boşanmak istediğinden **emin misin?**\nÇocukların aile ağacında kalır, ebeveynler silinmez.${feeText}`,
      yes: fee.amount > 0 ? `💔 Evet, boşan (-${nf(fee.amount)})` : '💔 Evet, boşan', no: '↩️ Vazgeç',
    });
  }

  // Anlaşmalı boşanma: iki taraf da ayrılmak istiyor, nafaka yok. Teklif eşe gider, o onaylarsa boşanılır.
  async function agreedDivorce(message) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const a = uidOf(message), g = G(gid), s = g.spouse[a];
    if (!s) return message.reply('Zaten evli değilsin 🙂');
    if (onCooldown(`x:${a}:${s}`)) return message.reply('Eşine az önce teklif ettin, biraz bekle 💌');
    return propose(message, gid, 'x', a, s, {
      mention: s, title: '🤝 Anlaşmalı Boşanma Teklifi', color: COLORS.warn,
      text: `<@${a}>, seninle **anlaşmalı olarak boşanmak** istiyor <@${s}>.\nİkiniz de kabul ederseniz **kimse nafaka ödemez**. Çocuklar aile ağacında kalır.`,
      yes: '🤝 Anlaşmalı Boşan', no: '❌ Reddet',
    });
  }

  async function adopt(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const me = ['me', 'ben'].includes(String(args[0] ?? '').toLowerCase());
    const a = uidOf(message), b = targetOf(message, me ? args[1] : args[0]);
    if (!b) return message.reply(me ? 'Kullanım: !adopt me <kullanıcı>  (seni evlat edinmesini ister)' : 'Kullanım: !adopt <kullanıcı>  (onu evlat edinmek ister)\nSeni evlat edinmesi için: !adopt me <kullanıcı>');
    if (b === botId()) return message.reply('Ben botum, beni evlat edinemezsin 🥺');
    const g = G(gid);
    const parent = me ? b : a, child = me ? a : b;
    const err = adoptError(g, parent, child);
    if (err) return message.reply(`${err}${err.includes('ebeveyne sahip') ? '\nTeklif otomatik olarak reddedildi 💔' : ''}`);
    if (onCooldown(`${me ? 'p' : 'a'}:${a}:${b}`)) return message.reply('Bu kişiye az önce teklif ettin, biraz bekle 💌');
    return me
      ? propose(message, gid, 'p', a, b, { mention: b, title: '👨‍👧 Evlat Edinilme İsteği', text: `<@${a}>, <@${b}> tarafından **evlat edinilmek** istiyor!\nKabul edersen <@${a}> aile ağacında senin çocuğun olur.` })
      : propose(message, gid, 'a', a, b, { mention: b, title: '👨‍👧 Evlat Edinme Teklifi', text: `<@${a}>, seni **evlat edinmek** istiyor <@${b}>!\nKabul edersen aile ağacında onun çocuğu olursun.` });
  }

  // ---------- PNG yükleme (Jubbio) ----------
  // uploadAttachment'in imzası belgelenmediği için olası çağrı biçimleri sırayla denenir.
  // Çalışan biçim hatırlanır. Hiçbiri olmazsa metotların kaynağı konsola yazılır.
  let uploadMode = null, uploadDumped = false;
   // dönen cevabın içindeki ilk http adresini bulur (alan adı ne olursa olsun)
  const pickUrl = (r, depth = 0) => {
    if (!r || depth > 4) return null;
    if (typeof r === 'string') return /^https?:\/\//i.test(r) ? r : null;
    if (typeof r === 'object') {
      for (const v of Object.values(r)) {
        const u = pickUrl(v, depth + 1);
        if (u) return u;
      }
    }
    return null;
  };

  async function uploadPng(message, gid, png) {
    const rest = client.rest;
    if (typeof rest?.uploadAttachment !== 'function') return null;
    try {
      const r = await rest.uploadAttachment(gid, message.channelId, {
        data: png, name: 'aile.png', contentType: 'image/png',
      });
      const url = pickUrl(r);
      if (url) return url;
      console.warn('[aile] Yükleme tamam ama adres bulunamadı. Dönen:', JSON.stringify(r)?.slice(0, 500));
    } catch (e) { console.warn('[aile] Yükleme hatası:', e?.message || e); }
    return null;
  }

  async function disown(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const a = uidOf(message), b = targetOf(message, args[0]);
    if (!b) return message.reply('Kullanım: !evlat-reddet <kullanıcı> [anlasmali]  (ya da !disown <kullanıcı>)\nİkiniz de ayrılmak istiyorsanız nafakasız: !evlat-reddet <kullanıcı> anlasmali');
    if (b === a) return message.reply('Kendini evlatlıktan reddedemezsin 😅');
    const g = G(gid);
    if (!parentsOf(g, b).includes(a)) {
      return message.reply(kidsOf(g, a).includes(b)
        ? `<@${b}> sadece eşinin evladı, bu bağı ancak eşin kaldırabilir.`
        : `<@${b}> senin evladın değil.`);
    }
    if (onCooldown(`r:${a}:${b}`)) return message.reply('Biraz bekle, az önce bunu denedin.');
    // Anlaşmalı: evlat da ayrılmak istiyorsa teklif ona gider, nafaka yok
    if (AGREED_WORDS.includes(String(args[1] ?? '').toLowerCase())) {
      return propose(message, gid, 's', a, b, {
        mention: b, title: '🤝 Anlaşmalı Ayrılık Teklifi', color: COLORS.warn,
        text: `<@${a}>, seninle ebeveyn-evlat bağını **anlaşmalı olarak** sonlandırmak istiyor <@${b}>.\nKabul edersen bağ **nafaka ödenmeden** kalkar.`,
        yes: '🤝 Kabul Et', no: '❌ Reddet',
      });
    }
    const fee = quoteFee(a, FEE_CHILD);
    const feeText = fee.amount > 0
      ? `\n\n💸 **Nafaka:** ${fm(fee.amount)} bakiyenden <@${b}> kişisine ödenecek.\n🤝 <@${b}> da ayrılmak istiyorsa nafakasız yol: \`!evlat-reddet <@${b}> anlasmali\``
      : '';
    return propose(message, gid, 'r', a, b, {
      mention: a, title: '💔 Evlat Reddetme Onayı', color: COLORS.warn, extra: fee.amount,
      text: `<@${a}>, <@${b}> kişisini evlatlıktan reddetmek istediğinden **emin misin?**\nAile ağacındaki ebeveyn bağı silinir. <@${b}> kişisinin kendi çocukları ve diğer bağları kalır.${feeText}`,
      yes: fee.amount > 0 ? `💔 Evet, reddet (-${nf(fee.amount)})` : '💔 Evet, reddet', no: '↩️ Vazgeç',
    });
  }

  async function aile(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const root = targetOf(message, args[0]) ?? uidOf(message);
    const g = G(gid);
    const base = render(g, root);
    if (base.empty) {
      if (root === uidOf(message)) return message.reply('Henüz bir ailen yok 🌱 `!evlen <kullanıcı>` ya da `!adopt <kullanıcı>` ile başlayabilirsin.');
      const who = await userInfo(gid, root);
      return message.reply(`**${esc(who.name)}** kişisinin henüz bir ailesi yok 🌱`);
    }

    // ağaçtaki herkesin adını çöz (etiket yerine kullanıcı adı yazılacak)
    const ids = new Set([root]);
    for (const l of base.lines) for (const m of l.matchAll(/<@(\d+)>/g)) ids.add(m[1]);
    const names = new Map();
    await Promise.all([...ids].map(async (id) => names.set(id, (await userInfo(gid, id)).name)));
    const nameOf = (u) => esc(names.get(String(u)) || 'Bilinmeyen');

    // 1) Görsel ağaç (Jubbio: önce rest.uploadAttachment ile yükle, dönen adresi embed'e koy)
          if (renderTree) {
      try {
        const sp = g.spouse[root], ts = g.since[root];
        const sinceText = sp && ts ? `${new Date(ts).toLocaleDateString('tr-TR')} tarihinden beri birlikteler` : null;
        const png = await renderTree(g, root, {
          parentsOf, childrenOf, kidsOf, sinceText,
          resolve: (id) => userInfo(gid, id),
        });

        await client.rest.createMessageWithFile(gid, message.channelId, {
          file: { data: png, name: 'aile.png', contentType: 'image/png' },
        });
        return;
      } catch (err) { console.warn('[aile] Görsel gönderilemedi, metne dönülüyor:', err?.message || err); }
    }
    
    // 2) Yedek: kullanıcı adlı metin ağaç
    let text = render(g, root, nameOf).lines.join('\n');
    if (text.length > 3800) text = text.slice(0, 3800) + '\n…';
    return message.reply({ embeds: [{ title: '🌳 Aile Ağacı', description: text, color: PINK, footer: { text: 'RINAE • Aile' } }] });
  }

  Object.assign(commands, { marry, divorce, adopt, aile, disown });
  commands['anlasmali-bosan'] = agreedDivorce;
  commands.anlasmalibosan = agreedDivorce;
  commands['anlaşmalı-boşan'] = agreedDivorce;
  commands.evlen = marry;
  commands.bosan = divorce;
  commands['boşan'] = divorce;
  commands.evlatedin = adopt;
  commands.family = aile;
  commands['evlat-reddet'] = disown;
  commands.evlatreddet = disown;

  // ---------- Buton tıklamaları (fm:<tür>:<y|n>:<gönderen>:<hedef>:<zaman>) ----------
  async function handleInteraction(interaction, customId) {
    const [, kind, v, from, to, ts, amtRaw] = customId.split(':');
    const uid = String(interaction.user?.id ?? interaction.member?.user?.id ?? interaction.userId ?? '');
    const gid = String(interaction.guildId ?? interaction.guild?.id ?? '');
    if (!uid || !gid) return respondPrivate(interaction, 'Bir sorun oluştu, komutu tekrar yaz.');
    const allowed = kind === 'd' || kind === 'r' ? from : to;
    if (uid !== allowed) {
      return respondPrivate(interaction, kind === 'd' ? 'Bu onay sadece boşanmak isteyen kişiye ait.' : kind === 'r' ? 'Bu onay sadece reddetmek isteyen ebeveyne ait.' : kind === 'x' || kind === 's' ? 'Bu anlaşmalı ayrılık teklifi sana ait değil.' : 'Bu teklif sana ait değil 🥺');
    }
    const done = async (title, description, color) => respondUpdate(interaction, { embeds: [{ title, description: await named(gid, description), color }], components: [] });
    if (Date.now() - parseInt(ts, 36) > TTL) return done('⏰ Süre doldu', 'Bu teklifin süresi doldu, istersen yeniden gönderebilirsin.', COLORS.warn);
    const g = G(gid);

    if (v === 'n') {
      const msg = { m: `💔 <@${to}> evlilik teklifini reddetti.`, a: `💔 <@${to}> evlat edinilmeyi reddetti.`, p: `💔 <@${to}> seni evlat edinmeyi reddetti.`, d: '↩️ Boşanmaktan vazgeçildi, aile devam ediyor 💞', r: '↩️ Vazgeçildi, aile bağı korunuyor 💞', x: `💞 <@${to}> anlaşmalı boşanmayı kabul etmedi, evlilik devam ediyor.`, s: `💞 <@${to}> anlaşmalı ayrılığı kabul etmedi, aile bağı korunuyor.` }[kind];
      return done(kind === 'd' || kind === 'r' ? 'Vazgeçildi' : 'Teklif reddedildi', msg ?? 'Reddedildi.', kind === 'd' || kind === 'r' ? COLORS.warn : COLORS.bad);
    }

    if (kind === 'm') {
      if (g.spouse[from] || g.spouse[to]) return done('💔 Teklif geçersiz', `<@${g.spouse[from] ? from : to}> bu arada başkasıyla evlendi, teklif otomatik reddedildi.`, COLORS.bad);
      if (related(g, from, to)) return done('💔 Teklif geçersiz', 'Aile bireyleri evlenemez.', COLORS.bad);
      g.spouse[from] = to; g.spouse[to] = from;
      g.since[from] = g.since[to] = Date.now();
      save();
      return done('💍 Tebrikler!', `<@${from}> ve <@${to}> artık evli! 🎉\nAile ağacını görmek için \`!aile\` yaz.`, COLORS.ok);
    }
    if (kind === 'a' || kind === 'p') {
      const parent = kind === 'a' ? from : to, child = kind === 'a' ? to : from;
      const err = adoptError(g, parent, child);
      if (err) return done('💔 Teklif geçersiz', err, COLORS.bad);
      (g.parents[child] ||= []).push(parent);
      save();
      return done('👨‍👧 Aileye hoş geldin!', `<@${child}> artık <@${parent}> kişisinin çocuğu! 🎉\nAile ağacını görmek için \`!aile\` yaz.`, COLORS.ok);
    }
    if (kind === 'd') {
      if (g.spouse[from] !== to) return done('Zaten evli değilsiniz', 'Bu evlilik artık geçerli değil.', COLORS.warn);
      // nafaka: önce öde, sonra boşan (aralarında await yok, çift tıklamada iki kez ödenmez)
      const amt = Math.max(0, parseInt(amtRaw, 10) || 0);
      const pay = payFee(from, to, amt);
      if (!pay.ok) return done('💸 Nafaka ödenemedi', `Nafaka bedeli ${fm(amt)} bakiyende yok, boşanma gerçekleşmedi.\nParan yetene kadar bekleyebilir ya da eşinle \`!anlasmali-bosan\` deneyebilirsin.`, COLORS.bad);
      delete g.spouse[from]; delete g.spouse[to]; delete g.since[from]; delete g.since[to];
      save();
      return done('💔 Boşandınız', `<@${from}> ve <@${to}> artık evli değil.${pay.paid ? `\n💸 <@${from}>, <@${to}> kişisine ${fm(pay.paid)} nafaka ödedi.` : ''}\nÇocukların aile ağacında kalmaya devam ediyor.`, COLORS.warn);
    }
    if (kind === 'x') {
      if (g.spouse[from] !== to) return done('Zaten evli değilsiniz', 'Bu evlilik artık geçerli değil.', COLORS.warn);
      delete g.spouse[from]; delete g.spouse[to]; delete g.since[from]; delete g.since[to];
      save();
      return done('🤝 Anlaşmalı boşandınız', `<@${from}> ve <@${to}> karşılıklı anlaşarak ayrıldı.\nNafaka ödenmedi. Çocukların aile ağacında kalmaya devam ediyor.`, COLORS.warn);
    }
    if (kind === 'r') {
      if (!parentsOf(g, to).includes(from)) return done('Zaten bağ yok', 'Bu kişi artık senin evladın değil.', COLORS.warn);
      const amt = Math.max(0, parseInt(amtRaw, 10) || 0);
      const pay = payFee(from, to, amt);
      if (!pay.ok) return done('💸 Nafaka ödenemedi', `Nafaka bedeli ${fm(amt)} bakiyende yok, evlat reddi gerçekleşmedi.\nParan yetene kadar bekleyebilir ya da evladınla \`!evlat-reddet <kullanıcı> anlasmali\` deneyebilirsin.`, COLORS.bad);
      g.parents[to] = parentsOf(g, to).filter((p) => p !== from);
      if (!g.parents[to].length) delete g.parents[to];
      save();
      return done('💔 Evlat reddedildi', `<@${to}> artık <@${from}> kişisinin evladı değil.${pay.paid ? `\n💸 <@${from}>, <@${to}> kişisine ${fm(pay.paid)} nafaka ödedi.` : ''}\nAile ağacını görmek için \`!aile\` yaz.`, COLORS.warn);
    }
    if (kind === 's') {
      if (!parentsOf(g, to).includes(from)) return done('Zaten bağ yok', 'Bu kişi artık senin evladın değil.', COLORS.warn);
      g.parents[to] = parentsOf(g, to).filter((p) => p !== from);
      if (!g.parents[to].length) delete g.parents[to];
      save();
      return done('🤝 Anlaşmalı ayrılık', `<@${to}> artık <@${from}> kişisinin evladı değil. Karşılıklı anlaşıldığı için nafaka ödenmedi.`, COLORS.warn);
    }
    return respondPrivate(interaction, 'Bu buton artık geçerli değil.');
  }

  // ---------- Yardım ----------
  const oldC = HELP_PAGES?.community;
  if (HELP_PAGES) {
    HELP_PAGES.community = () => {
      const p = oldC ? oldC() : { title: '🎪 Topluluk Komutları', color: COLORS.ok, fields: [] };
      p.fields.push({
        name: '💞 Aile',
        value: '`!evlen <kullanıcı>` / `!marry` evlilik teklifi\n`!bosan` / `!divorce` boşanma (**nafaka** öder)\n`!anlasmali-bosan` iki taraf da isterse nafakasız boşanma\n`!adopt <kullanıcı>` evlat edin • `!adopt me <kullanıcı>` seni evlat edinsin\n`!evlat-reddet <kullanıcı>` / `!disown` evladını reddet (**nafaka** öder) • sonuna `anlasmali` yazarsan evladın da onaylayınca nafakasız\n`!aile [kullanıcı]` aile ağacı',
        inline: false,
      });
      return p;
    };
  }

  return { handleInteraction, flush: save };
}

module.exports = { init };