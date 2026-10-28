// RINAE Ekonomi: OwO tarzı para sistemi (günlük, çalış, av, hayvanat, kumar, blackjack, para gönder, sıralama)
// Panel: !ekonomi (butonlu)
// Komutlar: !para !gunluk !calis !av !hayvanat !sat !yazitura !slot !blackjack !gonder !zengin
// Blackjack: !blackjack <miktar> (!bj, !21) -> butonlar: Kart Çek / Dur / Katla  (yazıyla: !hit !stand !double)
// Yönetici (sadece bot yetkilileri): !para-ver !para-al
// Veriler ekonomi.json dosyasında tutulur. EKONOMİ GLOBALDİR: bir kullanıcının bakiyesi, hayvanatı, serisi ve
// bekleme süreleri botun bulunduğu tüm sunucularda ortaktır. Eski sunucu bazlı veri ilk açılışta otomatik birleştirilir.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'ekonomi.json');
const LEGACY_BACKUP = path.join(__dirname, 'ekonomi.sunucu-bazli-yedek.json'); // global yapıya geçmeden önceki ham veri
// Yazı tura emojileri: bot açılırken coin_flip.gif / coin_yazi.png / coin_tura.png dosyaları (bu dosyanın yanında olmalı)
// BOTUN KENDİ (uygulama) emojisi olarak otomatik yüklenir -> hangi sunucuda olursa olsun çalışır.
// İstersen elle de doldurabilirsin: { anim: '<a:rinae_coinflip:ID>', ... }. Yüklenemezse eski 🪙 ile animasyonsuz devam eder.
// Özel (custom) emojiler tek bir sunucuya bağlıdır, diğer sunucularda doğru görünmeyebilir.
// UNIVERSAL_EMOJI = false -> aşağıdaki özel emojiler kullanılır (şu anki ayar)
// UNIVERSAL_EMOJI = true  -> özel emoji yerine standart emojiler (🪙 📜 👑) kullanılır
const UNIVERSAL_EMOJI = false;
const CUSTOM_COIN = { anim: '<a:coin_flip:636640169683853312>', yazi: '<:coin_yazi:636640138578894848>', tura: '<:coin_tura:636640119742275584>' };
const COIN = UNIVERSAL_EMOJI ? { anim: '🪙', yazi: '📜', tura: '👑' } : CUSTOM_COIN;
// Para birimi simgesi: evrensel modda 🪙; özel modda coinin ana yüzü (tura)
const CUR = UNIVERSAL_EMOJI ? '🪙' : (COIN.tura || '🪙');
const CUR_NAME = 'Rinecy';  // para biriminin adı
const COIN_SPIN_MS = 4500;  // havada dönme süresi (GIF 4,5 sn)
const START = 500;          // yeni kullanıcının başlangıç parası
const MAX_BET = 300000;      // tek seferde en fazla bahis
const MAX_CASH = 1e12;
const SEND_LIMIT = 50000;   // !gonder ile bir kullanıcının GÜNLÜK (gece 00:00 TR'de sıfırlanır) gönderebileceği toplam miktar
const HUNT_COST = 25;       // her av
const WORK_CD = 30 * 60e3;  // !calis bekleme süresi
const HUNT_CD = 20e3;
const GAMBLE_CD = 5e3;
const BJ_TTL = 3 * 60e3;    // blackjack: bu süre işlem yapılmazsa otomatik "dur" sayılır
const TR = 3 * 3600e3, DAY = 864e5;

const RARITY = {
  yaygin: { label: 'Yaygın', w: 60, value: 6, icon: '⚪' },
  nadir: { label: 'Nadir', w: 25, value: 14, icon: '🟢' },
  ender: { label: 'Ender', w: 10, value: 40, icon: '🔵' },
  destansi: { label: 'Destansı', w: 4, value: 150, icon: '🟣' },
  efsanevi: { label: 'Efsanevi', w: 1, value: 800, icon: '🟡' },
};
const RAR_ALIAS = { yaygin: 'yaygin', yaygın: 'yaygin', nadir: 'nadir', ender: 'ender', destansi: 'destansi', destansı: 'destansi', efsanevi: 'efsanevi' };
const ANIMALS = [
  ['fare', '🐀', 'Fare', 'yaygin'], ['tavsan', '🐇', 'Tavşan', 'yaygin'], ['sincap', '🐿️', 'Sincap', 'yaygin'],
  ['tavuk', '🐔', 'Tavuk', 'yaygin'], ['kurbaga', '🐸', 'Kurbağa', 'yaygin'], ['tirtil', '🐛', 'Tırtıl', 'yaygin'],
  ['tilki', '🦊', 'Tilki', 'nadir'], ['kurt', '🐺', 'Kurt', 'nadir'], ['geyik', '🦌', 'Geyik', 'nadir'],
  ['baykus', '🦉', 'Baykuş', 'nadir'], ['kaplumbaga', '🐢', 'Kaplumbağa', 'nadir'],
  ['kaplan', '🐯', 'Kaplan', 'ender'], ['aslan', '🦁', 'Aslan', 'ender'], ['fil', '🐘', 'Fil', 'ender'],
  ['panda', '🐼', 'Panda', 'ender'], ['kopekbaligi', '🦈', 'Köpekbalığı', 'ender'],
  ['unicorn', '🦄', 'Tek Boynuzlu At', 'destansi'], ['kartal', '🦅', 'Kartal', 'destansi'], ['kirbac', '🐙', 'Dev Ahtapot', 'destansi'],
  ['ejderha', '🐉', 'Ejderha', 'efsanevi'], ['trex', '🦖', 'T-Rex', 'efsanevi'], ['brontozor', '🦕', 'Brontozor', 'efsanevi'],
].map(([id, emoji, name, rar]) => ({ id, emoji, name, rar }));
const ANIMAL = Object.fromEntries(ANIMALS.map((a) => [a.id, a]));

const JOBS = [
  'kafede garsonluk yaptın', 'kargo dağıttın', 'bir oyunu test ettin', 'sokakta müzik yaptın', 'komşunun bahçesini suladın',
  'çizim siparişi teslim ettin', 'pazarda tezgâh açtın', 'ödev yaptın (başkasının)', 'bot kodladın', 'kedi bakıcılığı yaptın',
];
const SLOT = [['🍒', 30, 3], ['🍋', 25, 4], ['🍉', 20, 6], ['⭐', 15, 10], ['💎', 8, 25], ['7️⃣', 2, 100]]; // [emoji, ağırlık, 3'lü çarpan]
const SLOT_PAIR = 1.5;

// ---------- Blackjack kartları ----------
// Kart = 0..51 arası sayı. rank = i % 13 (0=As, 1..9 = 2..10, 10=J, 11=Q, 12=K), suit = floor(i / 13)
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠️', '♥️', '♦️', '♣️'];
const cardStr = (i) => `\`${RANKS[i % 13]}${SUITS[Math.floor(i / 13)]}\``;
const cardVal = (i) => { const r = i % 13; return r === 0 ? 11 : r >= 10 ? 10 : r + 1; };
function handVal(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += cardVal(c); if (c % 13 === 0) aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
const isNatural = (cards) => cards.length === 2 && handVal(cards) === 21;
const showHand = (cards) => cards.map(cardStr).join(' ');
function newDeck() {
  const d = Array.from({ length: 52 }, (_, i) => i);
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ---------- Yardımcılar ----------
const trLower = (t) => String(t ?? '').toLocaleLowerCase('tr-TR');
const nf = (n) => Number(n).toLocaleString('tr-TR');
const money = (n) => `**${nf(n)}** ${CUR}`;
const rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
// yazı tura sonuç cümleleri (c: seçtiğin, f: gelen) -> rastgele biri seçilir
// m: kazanılan miktar (örn. "**100** 🪙"), "kazandın"dan hemen önce yazılır
const CF_WIN = [
  (c, f, m) => `**${c}** demiştin, **${f}** geldi, ${m} kazandın! 🎉`,
  (c, f, m) => `**${f}** geldi, tam beklediğin gibi! ${m} kazandın 🎉`,
  (c, f, m) => `Şans bugün yanında, **${f}** geldi! ${m} kazandın ✨`,
  (c, f, m) => `**${c}** seçmiştin, **${f}** geldi, helal olsun! ${m} kazandın 🎉`,
];
const CF_LOSE = [
  (c, f) => `**${c}** seçmiştin, **${f}** geldi, kaybettin :c`,
  (c, f) => `**${f}** geldi, olmadı bu sefer :c`,
  (c, f) => `Maalesef **${f}** geldi, kaybettin :c`,
  (c, f) => `**${c}** demiştin ama **${f}** düştü, bir dahaki sefere :c`,
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dayKey = (t = Date.now()) => new Date(t + TR).toISOString().slice(0, 10);
const fmtDur = (ms) => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return [h ? `${h} sa` : '', m ? `${m} dk` : '', !h && !m ? `${sec} sn` : ''].filter(Boolean).join(' ');
};
function weighted(items, wOf) {
  const total = items.reduce((a, x) => a + wOf(x), 0);
  let r = Math.random() * total;
  for (const x of items) { r -= wOf(x); if (r < 0) return x; }
  return items[items.length - 1];
}

function init(ctx) {
  const { client, commands, HELP_PAGES, guildIdOf, resolveUserIds, isSuper, makeRow, sendPanel, respondPrivate } = ctx;
  const COLORS = ctx.COLORS || { main: 0x5865f2, ok: 0x57f287, bad: 0xed4245, warn: 0xfee75c };

  const respondUpdate = ctx.respondUpdate || (async (interaction, payload) => {
    if (typeof interaction.update === 'function') return interaction.update(payload);
    if (typeof interaction.reply === 'function') return interaction.reply(payload);
    return respondPrivate(interaction, payload);
  });

  // Jubbio'da uygulama emojisi yok. İstersen elle doldur:
  // const COIN = { anim: '<a:ad:ID>', yazi: '<:ad:ID>', tura: '<:ad:ID>' };
  function embedToText(embed) {
    if (!embed) return ' ';
    const lines = [embed.title, embed.description];
    for (const f of embed.fields ?? []) lines.push(`${f.name}: ${f.value}`);
    return lines.filter(Boolean).join('\n').slice(0, 1900);
  }

  async function restPost(gid, channelId, payload) {
    const url = `/bot/guilds/${gid}/channels/${channelId}/messages`;
    const body = JSON.parse(JSON.stringify(payload));
    try {
      return await client.rest.request('POST', url, body);
    } catch (e) {
      if (body.components) {
        try { return await client.rest.request('POST', url, { ...body, components: undefined }); } catch { /* düz yazı */ }
      }
      if (body.embeds?.length) return client.rest.request('POST', url, { content: embedToText(body.embeds[0]) });
      throw e;
    }
  }

  async function restPatch(gid, channelId, messageId, payload) {
    const url = `/bot/guilds/${gid}/channels/${channelId}/messages/${messageId}`;
    const body = typeof payload === 'string' ? { content: payload } : payload;
    return client.rest.request('PATCH', url, JSON.parse(JSON.stringify(body)));
  }

  // message.reply Jubbio'da embed/buton kabul etmezse index.js ile aynı REST yoluna düşer
  function bind(message) {
    if (!message || message.__ekoBound) return message;
    const gid = guildIdOf(message);
    const orig = typeof message.reply === 'function' ? message.reply.bind(message) : null;
    message.reply = async (p) => {
      const payload = typeof p === 'string' ? { content: p } : p;
      let sent = null;
      if (orig) {
        try { sent = await orig(payload); } catch { sent = null; }
      }
      if (!sent) sent = await restPost(gid, message.channelId, payload);
      const id = sent?.id ?? sent?.message_id ?? sent?.messageId;
      if (sent && typeof sent.edit !== 'function' && id) {
        sent.edit = (next) => restPatch(gid, message.channelId, id, next);
      }
      return sent ?? { id, edit: (next) => restPatch(gid, message.channelId, id, next) };
    };
    message.__ekoBound = true;
    return message;
  }

  // Eski (sunucu bazlı) veriyi global yapıya birleştirir.
  // Kural: bakiye ve hayvan sayıları -> sunucular arası EN YÜKSEK değer (para/hayvan çoğaltılmaz),
  // toplam av ve kumar kâr/zararı -> toplanır, günlük seri -> en güncel günlüğe ait olan.
  function mergeGuilds(guilds) {
    const users = {};
    for (const g of Object.values(guilds || {})) {
      for (const [uid, u] of Object.entries(g?.users || {})) {
        const m = users[uid];
        if (!m) { users[uid] = { ...u, zoo: { ...(u.zoo || {}) } }; continue; }
        m.cash = Math.max(m.cash || 0, u.cash || 0);
        for (const [k, v] of Object.entries(u.zoo || {})) m.zoo[k] = Math.max(m.zoo[k] || 0, v);
        m.hunts = (m.hunts || 0) + (u.hunts || 0);
        m.net = (m.net || 0) + (u.net || 0);
        m.workAt = Math.max(m.workAt || 0, u.workAt || 0);
        const a = m.lastDaily || '', b = u.lastDaily || '';
        if (b > a) { m.lastDaily = u.lastDaily; m.streak = u.streak || 0; }
        else if (b === a) m.streak = Math.max(m.streak || 0, u.streak || 0);
        if (u.bj) { if (!m.bj) m.bj = u.bj; else m.cash += u.bj.bet || 0; } // ikinci açık oyunun bahsi iade
      }
    }
    return users;
  }

  function load() {
    for (const f of [FILE, FILE + '.bak']) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        if (!j || typeof j !== 'object') continue;
        if (j.users && !j.guilds) return { db: { users: j.users }, legacy: false };
        if (j.guilds) {
          try { fs.copyFileSync(f, LEGACY_BACKUP); } catch (e) { console.warn('[ekonomi] eski veri yedeği alınamadı:', e.message); }
          const users = mergeGuilds(j.guilds);
          console.log(`[ekonomi] sunucu bazlı veri global yapıya taşındı (${Object.keys(users).length} kullanıcı). Yedek: ${path.basename(LEGACY_BACKUP)}`);
          return { db: { users }, legacy: true };
        }
      } catch { /* sıradaki */ }
    }
    return { db: { users: {} }, legacy: false };
  }

  const loaded = load();
  const DB = loaded.db;
  let timer = null, dirty = loaded.legacy; // taşıma yapıldıysa yeni biçim hemen diske yazılsın
  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(DB));
      if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* yoksay */ } }
      fs.renameSync(tmp, FILE);
    } catch (e) { dirty = true; console.warn('[ekonomi] kaydedilemedi:', e.message); }
  }
  const touch = () => { dirty = true; if (!timer) { timer = setTimeout(flush, 1500); timer.unref?.(); } };
  process.on('exit', flush); // yeniden başlatma / kapanışta son hali yaz
  if (dirty) touch();

  // Kullanıcı hesabı artık sunucudan bağımsız: sadece kullanıcı ID'si
  const U = (uid) => {
    const u = (DB.users[uid] ||= { cash: START, streak: 0, lastDaily: null, workAt: 0, zoo: {}, hunts: 0, net: 0 });
    u.zoo ||= {};
    return u;
  };
  const add = (u, n) => { u.cash = Math.max(0, Math.min(MAX_CASH, u.cash + n)); touch(); };

  // kısa bekleme süreleri (bellekte)
  const cd = new Map();
  const left = (k) => Math.max(0, (cd.get(k) || 0) - Date.now());
  const setCd = (k, ms) => cd.set(k, Date.now() + ms);

  const who = (message) => ({ gid: guildIdOf(message), uid: String(message.author?.id) });
  const needGuild = (message, gid) => (gid ? false : (message.reply('Bu komut sadece sunucuda kullanılabilir.'), true));
  const targetOf = (message, raw) => {
    const id = raw ? resolveUserIds(message, raw)[0] : null;
    if (!id) return null;
    // @etiketle yazılan kullanıcı her uzunlukta olabilir (eski hesapların ID'si kısa: 1500 gibi).
    // Düz sayı yazıldıysa küçük miktarlar kullanıcı sanılmasın diye en az 5 hane aranır.
    const mention = /^<@!?\d+>$/.test(String(raw));
    return (mention ? /^\d{1,25}$/ : /^\d{5,25}$/).test(id) ? id : null;
  };

  function parseBet(raw, u) {
    const t = trLower(raw || '').replace(',', '.');
    if (!t) return { err: 'Bahis miktarını yaz. Örnek: `!slot 100` ya da `!slot hepsi`' };
    let n;
    if (['hepsi', 'all', 'tümü', 'tumu'].includes(t)) n = Math.min(u.cash, MAX_BET);
    else {
      const m = t.match(/^(\d+(?:\.\d+)?)(k)?$/);
      if (!m) return { err: 'Geçerli bir miktar yaz. Örnek: `100`, `2k`, `hepsi`' };
      n = Math.floor(Number(m[1]) * (m[2] ? 1000 : 1));
    }
    if (!(n >= 1)) return { err: 'Bahis en az 1 olmalı.' };
    if (n > MAX_BET) return { err: `Tek seferde en fazla ${nf(MAX_BET)} ${CUR} oynayabilirsin.` };
    if (n > u.cash) return { err: `Yeterli paran yok. Bakiyen: ${money(u.cash)}` };
    return { n };
  }

  // ---------- Komutlar ----------
  async function para(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const target = targetOf(message, args[0]) ?? uid;
    const u = U(target);
    return message.reply({
      embeds: [{
        title: `${CUR_NAME} Cüzdanı`,
        description: `<@${target}>`,
        color: COLORS.main,
        fields: [
          { name: '💰 Bakiye', value: money(u.cash), inline: true },
          { name: '🔥 Günlük seri', value: `${u.streak} gün`, inline: true },
          { name: '🐾 Toplam av', value: nf(u.hunts), inline: true },
          { name: '🎰 Kumar kâr/zarar', value: `${u.net >= 0 ? '+' : ''}${nf(u.net)} ${CUR}`, inline: true },
        ],
        footer: { text: 'RINAE • Ekonomi' },
      }],
    });
  }

  async function gunluk(message) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const u = U(uid);
    const today = dayKey();
    if (u.lastDaily === today) {
      const nextMidnight = (Math.floor((Date.now() + TR) / DAY) + 1) * DAY - TR;
      return message.reply(`⏳ Bugünkü ödülünü zaten aldın. Yeni ödül **${fmtDur(nextMidnight - Date.now())}** sonra (gece 00:00 TR).`);
    }
    u.streak = u.lastDaily === dayKey(Date.now() - DAY) ? u.streak + 1 : 1;
    u.lastDaily = today;
    const reward = 250 + Math.min(u.streak, 30) * 25;
    add(u, reward);
    return message.reply(`🎁 Günlük ödülün: ${money(reward)}\n🔥 Seri: **${u.streak}** gün${u.streak < 30 ? ' (her gün ödül artar, 30. güne kadar)' : ' (maksimum ödül!)'}\n💰 Bakiye: ${money(u.cash)}`);
  }

  async function calis(message) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const u = U(uid);
    const wait = u.workAt + WORK_CD - Date.now();
    if (wait > 0) return message.reply(`⏳ Çok yorgunsun, **${fmtDur(wait)}** sonra tekrar çalışabilirsin.`);
    u.workAt = Date.now();
    const gain = rnd(80, 200);
    add(u, gain);
    return message.reply(`💼 ${pick(JOBS)} ve ${money(gain)} kazandın.\n💰 Bakiye: ${money(u.cash)}`);
  }

  async function yazitura(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const l = left(`g:${uid}`);
    if (l > 0) return message.reply(`⏳ Biraz yavaş, **${fmtDur(l)}** sonra tekrar oyna.`);
    const u = U(uid);
    const bet = parseBet(args[0], u);
    if (bet.err) return message.reply(bet.err);
    const s = trLower(args[1] || '');
    const choice = ['y', 'yazi', 'yazı'].includes(s) ? 'yazı' : ['t', 'tura'].includes(s) ? 'tura' : pick(['yazı', 'tura']);
    setCd(`g:${uid}`, GAMBLE_CD);
    add(u, -bet.n); // bahis önce düşülür
    const flip = Math.random() < 0.5 ? 'yazı' : 'tura';
    const face = (flip === 'yazı' ? COIN.yazi : COIN.tura) || CUR;
    const win = flip === choice;
    // sonuç hemen işlenir (bot yeniden başlasa bile bakiye tutarlı kalır), animasyon sadece gösteri
    if (win) { add(u, bet.n * 2); u.net += bet.n; } else { u.net -= bet.n; touch(); }
    const line = pick(win ? CF_WIN : CF_LOSE)(choice, flip, money(bet.n));
    const result = `${line} ${face}\n💰 Bakiye: ${money(u.cash)}`;
    // animasyon: sadece gerçek mesajda (düzenlenebilir) ve emoji tanımlıysa; butonlarda direkt sonuç
    if (COIN.anim && message.id) {
      try {
        const sent = await message.reply(`${COIN.anim} **${choice}** seçtin, ${money(bet.n)} bahis oynandı, para havada...`);
        if (sent && typeof sent.edit === 'function') {
          await sleep(COIN_SPIN_MS);
          return await sent.edit(result);
        }
        return sent;
      } catch (e) { console.warn('[ekonomi] yazı tura animasyonu hatası:', e?.message || e); }
    }
    return message.reply(result);
  }

  async function slot(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const l = left(`g:${uid}`);
    if (l > 0) return message.reply(`⏳ Biraz yavaş, **${fmtDur(l)}** sonra tekrar oyna.`);
    const u = U(uid);
    const bet = parseBet(args[0], u);
    if (bet.err) return message.reply(bet.err);
    setCd(`g:${uid}`, GAMBLE_CD);
    add(u, -bet.n);
    const r = [0, 0, 0].map(() => weighted(SLOT, (x) => x[1]));
    const view = `🎰 [ ${r.map((x) => x[0]).join(' | ')} ]`;
    let payout = 0, note = '';
    if (r[0][0] === r[1][0] && r[1][0] === r[2][0]) { payout = bet.n * r[0][2]; note = `🎉 **JACKPOT!** x${r[0][2]}`; }
    else if (r[0][0] === r[1][0] || r[1][0] === r[2][0] || r[0][0] === r[2][0]) { payout = Math.floor(bet.n * SLOT_PAIR); note = `✨ İkili! x${SLOT_PAIR}`; }
    if (payout) add(u, payout);
    u.net += payout - bet.n; touch();
    return message.reply(`${view}\n${payout ? `${note}\n🎉 Kazandın: +${money(payout - bet.n)}` : `💸 Kaybettin: -${money(bet.n)}`}\n💰 Bakiye: ${money(u.cash)}`);
  }

  // ---------- Blackjack ----------
  // Kurallar: kasa 17'de durur (soft 17 dahil). Blackjack (ilk iki kart 21) 3:2 öder. Katla: sadece ilk iki kartta,
  // bahis ikiye katlanır, tek kart çekilir ve oyun biter. Oyun veritabanında (u.bj) saklanır, bot yeniden başlasa da kaybolmaz.
  // 3 dakika işlem yapılmazsa oyun otomatik "dur" sayılır.
  function bjButtons(uid, u, g) {
    const defs = [
      { id: `eko:bj:hit:${uid}`, label: '🃏 Kart Çek', style: 'Primary' },
      { id: `eko:bj:stand:${uid}`, label: '✋ Dur', style: 'Success' },
    ];
    if (g.p.length === 2 && !g.dbl && u.cash >= g.bet) defs.push({ id: `eko:bj:double:${uid}`, label: `💰 Katla (+${nf(g.bet)})`, style: 'Danger' });
    return [makeRow(defs)];
  }

  function bjPayload(uid, u, g, over = null) {
    const pv = handVal(g.p);
    const hideDealer = !over;
    const dealerText = hideDealer ? `${cardStr(g.d[0])} \`🂠\`\nToplam: **${cardVal(g.d[0])}** + ?` : `${showHand(g.d)}\nToplam: **${handVal(g.d)}**`;
    const fields = [
      { name: '🧑 Senin elin', value: `${showHand(g.p)}\nToplam: **${pv}**`, inline: true },
      { name: '🤖 Kasa', value: dealerText, inline: true },
      { name: '💵 Bahis', value: money(g.bet) + (g.dbl ? ' (katlandı)' : ''), inline: true },
    ];
    if (over) {
      fields.push({ name: 'Sonuç', value: `${over.text}\n💰 Bakiye: ${money(u.cash)}`, inline: false });
      return {
        embeds: [{ title: '🃏 Blackjack', description: `<@${uid}>`, color: over.color, fields, footer: { text: 'Tekrar oynamak için !blackjack <miktar>' } }],
        components: [],
      };
    }
    return {
      embeds: [{
        title: '🃏 Blackjack', description: `<@${uid}> sıra sende!`, color: COLORS.main, fields,
        footer: { text: 'Butonlar çalışmazsa: !hit • !stand • !double' },
      }],
      components: bjButtons(uid, u, g),
    };
  }

  // Oyunu bitirir: kasa oynar, kazanç hesaplanır, veri güncellenir
  function bjFinish(u, g) {
    const pv = handVal(g.p);
    const pNat = isNatural(g.p) && !g.split;
    const dNat = isNatural(g.d);
    if (pv <= 21 && !pNat) { while (handVal(g.d) < 17) g.d.push(g.deck.pop()); }
    const dv = handVal(g.d);
    let payout = 0, text, color;
    if (pv > 21) { text = `💥 **Battın!** (${pv}) Kaybettin: -${money(g.bet)}`; color = COLORS.bad; }
    else if (pNat && dNat) { payout = g.bet; text = '🤝 İkiniz de **blackjack** yaptınız, bahsin iade edildi.'; color = COLORS.warn; }
    else if (pNat) { payout = Math.floor(g.bet * 2.5); text = `🎉 **BLACKJACK!** 3:2 ödedi: +${money(payout - g.bet)}`; color = COLORS.ok; }
    else if (dNat) { text = `😬 Kasada **blackjack** var. Kaybettin: -${money(g.bet)}`; color = COLORS.bad; }
    else if (dv > 21) { payout = g.bet * 2; text = `🎉 **Kasa battı!** (${dv}) Kazandın: +${money(g.bet)}`; color = COLORS.ok; }
    else if (pv > dv) { payout = g.bet * 2; text = `🎉 **Kazandın!** (${pv} > ${dv}) +${money(g.bet)}`; color = COLORS.ok; }
    else if (pv === dv) { payout = g.bet; text = `🤝 **Berabere** (${pv}), bahsin iade edildi.`; color = COLORS.warn; }
    else { text = `💸 **Kaybettin.** (${pv} < ${dv}) -${money(g.bet)}`; color = COLORS.bad; }
    if (payout) add(u, payout);
    u.net += payout - g.bet;
    u.bj = null;
    touch();
    return { text, color };
  }

  // Süresi dolmuş oyunu otomatik tamamlar. Sonuç varsa döner.
  function bjExpire(u) {
    const g = u.bj;
    if (!g || Date.now() - g.at <= BJ_TTL) return null;
    const over = bjFinish(u, g);
    return { g, over };
  }

  function bjStart(uid, raw) {
    const u = U(uid);
    let note = '';
    const ex = bjExpire(u);
    if (ex) note = `⌛ Önceki oyunun süresi dolduğu için otomatik "dur" sayıldı: ${ex.over.text}\n\n`;
    if (u.bj) return { err: 'Zaten devam eden bir blackjack oyunun var. Butonlara bas ya da `!hit` / `!stand` yaz.' };
    const l = left(`g:${uid}`);
    if (l > 0) return { err: `⏳ Biraz yavaş, **${fmtDur(l)}** sonra tekrar oyna.` };
    const bet = parseBet(raw, u);
    if (bet.err) return { err: bet.err.replace('!slot', '!blackjack') };
    setCd(`g:${uid}`, GAMBLE_CD);
    add(u, -bet.n);
    const g = { bet: bet.n, deck: newDeck(), p: [], d: [], dbl: false, at: Date.now() };
    g.p.push(g.deck.pop()); g.d.push(g.deck.pop()); g.p.push(g.deck.pop()); g.d.push(g.deck.pop());
    u.bj = g;
    touch();
    // ilk dağıtımda blackjack varsa oyun hemen biter
    if (isNatural(g.p) || isNatural(g.d)) {
      const over = bjFinish(u, g);
      return { payload: bjPayload(uid, u, g, over), note };
    }
    return { payload: bjPayload(uid, u, g), note };
  }

  // sub: hit | stand | double
  function bjAct(uid, sub) {
    const u = U(uid);
    const ex = bjExpire(u);
    if (ex) return { payload: bjPayload(uid, u, ex.g, ex.over), note: '⌛ Süre dolduğu için oyun otomatik "dur" sayıldı.\n' };
    const g = u.bj;
    if (!g) return { err: 'Devam eden bir blackjack oyunun yok. Başlamak için: `!blackjack <miktar>`' };
    g.at = Date.now();
    if (sub === 'hit') {
      g.p.push(g.deck.pop());
      const v = handVal(g.p);
      if (v >= 21) return { payload: bjPayload(uid, u, g, bjFinish(u, g)) }; // battı ya da 21 oldu: otomatik biter
    } else if (sub === 'double') {
      if (g.p.length !== 2 || g.dbl) return { err: 'Katlama sadece ilk iki kartta yapılabilir.' };
      if (u.cash < g.bet) return { err: `Katlamak için ${money(g.bet)} daha lazım. Bakiyen: ${money(u.cash)}` };
      add(u, -g.bet);
      g.bet *= 2;
      g.dbl = true;
      g.p.push(g.deck.pop());
      return { payload: bjPayload(uid, u, g, bjFinish(u, g)) };
    } else if (sub === 'stand') {
      return { payload: bjPayload(uid, u, g, bjFinish(u, g)) };
    } else return { err: 'Geçersiz işlem.' };
    touch();
    return { payload: bjPayload(uid, u, g) };
  }

  // Mesaja yanıt: butonlu gönder, olmazsa butonsuz
  async function bjReply(message, r) {
    if (r.err) return message.reply(r.err);
    const first = r.note ? { ...r.payload, content: r.note.trim() } : r.payload;
    try { return await message.reply(first); }
    catch {
      try { return await message.reply({ content: r.note?.trim() || undefined, embeds: r.payload.embeds }); }
      catch { return message.reply('Oyun güncellendi ama mesaj gönderilemedi, `!hit` / `!stand` ile devam edebilirsin.'); }
    }
  }
  async function blackjack(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    return bjReply(message, bjStart(uid, args[0]));
  }
  const bjCmd = (sub) => async (message) => {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    return bjReply(message, bjAct(uid, sub));
  };

  async function av(message) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const l = left(`h:${uid}`);
    if (l > 0) return message.reply(`⏳ Hayvanlar kaçtı, **${fmtDur(l)}** sonra tekrar avlanabilirsin.`);
    const u = U(uid);
    if (u.cash < HUNT_COST) return message.reply(`Avlanmak için ${money(HUNT_COST)} lazım (yem/ekipman). Bakiyen: ${money(u.cash)}`);
    setCd(`h:${uid}`, HUNT_CD);
    add(u, -HUNT_COST);
    const rar = weighted(Object.keys(RARITY), (k) => RARITY[k].w);
    const animal = pick(ANIMALS.filter((a) => a.rar === rar));
    u.zoo[animal.id] = (u.zoo[animal.id] || 0) + 1;
    u.hunts++; touch();
    const R = RARITY[rar];
    return message.reply(`🏹 ${money(HUNT_COST)} harcadın ve ${animal.emoji} **${animal.name}** yakaladın! ${R.icon} ${R.label} (değeri ${money(R.value)})${rar === 'efsanevi' ? '\n🌟 **EFSANEVİ!** Çok şanslısın!' : ''}`);
  }

  async function hayvanat(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const target = targetOf(message, args[0]) ?? uid;
    const u = U(target);
    const total = Object.values(u.zoo).reduce((a, b) => a + b, 0);
    if (!total) return message.reply(target === uid ? 'Hayvanatın boş 🌱 `!av` yazarak avlanmaya başla.' : `<@${target}> kişisinin hayvanatı boş.`);
    let worth = 0;
    const fields = Object.entries(RARITY).map(([k, R]) => {
      const mine = ANIMALS.filter((a) => a.rar === k && u.zoo[a.id] > 0);
      for (const a of mine) worth += u.zoo[a.id] * R.value;
      return { name: `${R.icon} ${R.label} (${R.value} ${CUR_NAME})`, value: mine.map((a) => `${a.emoji}×${u.zoo[a.id]}`).join('  ') || '—', inline: false };
    });
    return message.reply({
      embeds: [{ title: '🦁 Hayvanat', description: `<@${target}> • **${nf(total)}** hayvan • değeri ${money(worth)}`, color: COLORS.ok, fields, footer: { text: 'Satmak için: !sat hepsi | !sat <nadir|ender|destansı|efsanevi>' } }],
    });
  }

  async function sat(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const u = U(uid);
    const arg = trLower(args[0] || '');
    const all = ['hepsi', 'all', 'tümü', 'tumu'].includes(arg);
    const keys = all ? ['yaygin', 'nadir', 'ender'] : RAR_ALIAS[arg] ? [RAR_ALIAS[arg]] : null;
    if (!keys) return message.reply('Kullanım: `!sat hepsi` (yaygın/nadir/ender satılır) ya da `!sat <yaygın|nadir|ender|destansı|efsanevi>`');
    let count = 0, total = 0;
    for (const a of ANIMALS) {
      if (!keys.includes(a.rar) || !u.zoo[a.id]) continue;
      count += u.zoo[a.id]; total += u.zoo[a.id] * RARITY[a.rar].value;
      delete u.zoo[a.id];
    }
    if (!count) return message.reply('Satılacak hayvan yok.');
    add(u, total);
    const keep = all && ANIMALS.some((a) => (a.rar === 'destansi' || a.rar === 'efsanevi') && u.zoo[a.id]);
    return message.reply(`💰 **${nf(count)}** hayvan sattın ve ${money(total)} kazandın.\n💰 Bakiye: ${money(u.cash)}${keep ? '\n🛡️ Destansı ve efsanevileri korudum, satmak için `!sat destansı` / `!sat efsanevi` yaz.' : ''}`);
  }

  async function gonder(message, args) {
    const { gid, uid } = who(message);
    if (needGuild(message, gid)) return;
    const target = targetOf(message, args[0]);
    const n = Math.floor(Number(String(args[1] ?? '').replace(',', '.')));
    if (!target || !(n >= 1)) return message.reply('Kullanım: `!gonder <kullanıcı> <miktar>`');
    if (target === uid) return message.reply('Kendine para gönderemezsin 😅');
    const u = U(uid);
    if (n > u.cash) return message.reply(`Yeterli paran yok. Bakiyen: ${money(u.cash)}`);
    // günlük gönderim limiti (alt hesap ile para aktarmayı sınırlar)
    const today = dayKey();
    if (u.sentDay !== today) { u.sentDay = today; u.sentToday = 0; }
    const remaining = SEND_LIMIT - u.sentToday;
    if (n > remaining) {
      return message.reply(remaining > 0
        ? `🚫 Günlük gönderim limitin **${nf(SEND_LIMIT)}** ${CUR}. Bugün en fazla ${money(remaining)} daha gönderebilirsin.`
        : `🚫 Bugünkü gönderim limitini (**${nf(SEND_LIMIT)}** ${CUR}) doldurdun. Limit gece 00:00'da (TR) sıfırlanır.`);
    }
    u.sentToday += n;
    add(u, -n);
    add(U(target), n);
    return message.reply(`💸 <@${uid}> → <@${target}>: ${money(n)} gönderildi.\n📊 Bugünkü kalan gönderim hakkın: ${money(SEND_LIMIT - u.sentToday)}`);
  }

  async function zengin(message) {
    const gid = guildIdOf(message);
    if (needGuild(message, gid)) return;
    const rows = Object.entries(DB.users).sort((a, b) => b[1].cash - a[1].cash).slice(0, 10);
    if (!rows.length) return message.reply('Henüz kimsenin parası yok.');
    const medal = ['🥇', '🥈', '🥉'];
    return message.reply({
      embeds: [{ title: `🏆 En Zenginler (Global)`, color: COLORS.warn, description: rows.map(([id, v], i) => `${medal[i] || `**${i + 1}.**`} <@${id}> • ${money(v.cash)}`).join('\n'), footer: { text: 'RINAE • Ekonomi' } }],
    });
  }

  const adminOk = async (message) => {
    // Ekonomi global olduğu için herhangi bir sunucunun sahibi para basamasın: sadece bot yetkilileri
    if (isSuper?.(String(message.author?.id))) return true;
    await message.reply('Ekonomi tüm sunucularda ortak olduğu için bu komut sadece bot yetkililerine açık.');
    return false;
  };
  async function paraVer(message, args) {
    if (!(await adminOk(message))) return;
    const gid = guildIdOf(message);
    const target = targetOf(message, args[0]);
    const n = Math.floor(Number(args[1]));
    if (!gid || !target || !(n >= 1)) return message.reply('Kullanım: `!para-ver <kullanıcı> <miktar>`');
    const u = U(target); add(u, n);
    return message.reply(`✅ <@${target}> kişisine ${money(n)} verildi. Yeni bakiye: ${money(u.cash)}`);
  }
  async function paraAl(message, args) {
    if (!(await adminOk(message))) return;
    const gid = guildIdOf(message);
    const target = targetOf(message, args[0]);
    const n = Math.floor(Number(args[1]));
    if (!gid || !target || !(n >= 1)) return message.reply('Kullanım: `!para-al <kullanıcı> <miktar>`');
    const u = U(target); add(u, -n);
    return message.reply(`✅ <@${target}> kişisinden ${money(n)} alındı. Yeni bakiye: ${money(u.cash)}`);
  }


  // ---------- Panel (butonlu) ----------
  // Panel herkese açıktır; butona basan kişi kendi hesabıyla işlem yapar, sonuç sadece ona görünür.
  const btn = (id, label, style) => ({ id: `eko:${id}`, label, style });
  function panelPayload() {
    return {
      embeds: [{
        title: `${CUR_NAME} Ekonomi Paneli`,
        description: 'Aşağıdaki butonlara bas. İşlem **senin hesabınla** yapılır, sonuç sadece **sana** görünür.',
        color: COLORS.warn,
        fields: [
          { name: `${CUR_NAME} & Kazanç`, value: `💰 Cüzdan • 🎁 Günlük ödül • 💼 Çalış (30 dk'da bir)`, inline: false },
          { name: '🏹 Av', value: `Av: ${HUNT_COST} ${CUR} karşılığı hayvan yakala • Hayvanat: koleksiyonun • Sat: yaygın/nadir/enderleri satar`, inline: false },
          { name: '🎰 Kumar', value: `Hazır bahis butonları. Farklı miktar için: \`!slot <miktar>\`, \`!yazitura <miktar> [yazı|tura]\`, \`!blackjack <miktar>\` (en fazla ${nf(MAX_BET)})`, inline: false },
          { name: '🤝 Diğer', value: '`!gonder <kullanıcı> <miktar>` para gönderir', inline: false },
        ],
        footer: { text: `Başlangıç parası: ${nf(START)} • Ekonomi tüm sunucularda ortaktır` },
      }],
      components: [
        makeRow([btn('para', '💰 Cüzdan', 'Primary'), btn('gunluk', '🎁 Günlük', 'Success'), btn('calis', '💼 Çalış', 'Success'),
          btn('av', '🏹 Av', 'Success'), btn('zoo', '🦁 Hayvanat', 'Secondary')]),
        makeRow([btn('sat:hepsi', '💵 Hepsini Sat', 'Secondary'), btn('zengin', '🏆 Zenginler', 'Secondary'),
          btn('bj:100', '🃏 Blackjack 100', 'Danger'), btn('bj:1000', '🃏 Blackjack 1k', 'Danger')]),
        makeRow([btn('slot:100', '🎰 Slot 100', 'Danger'), btn('slot:1000', '🎰 Slot 1k', 'Danger'),
          btn('yt:100:yazi', '🪙 Yazı 100', 'Primary'), btn('yt:100:tura', '🪙 Tura 100', 'Primary'),
          btn('yt:1000:rastgele', '🪙 Yazı/Tura 1k', 'Primary')]),
      ],
    };
  }
  async function panel(message) {
    if (needGuild(message, guildIdOf(message))) return;
    return sendPanel(message, panelPayload());
  }

  // Buton tıklaması: komut fonksiyonunu sahte bir "mesaj" ile çalıştırır, yanıtı tıklayana özel gösterir
  async function handleInteraction(interaction, customId) {
    const parts = String(customId).split(':'); // eko:<işlem>:<arg1>:<arg2>
    const act = parts[1];
    const userId = interaction.user?.id ?? interaction.member?.user?.id ?? interaction.userId;
    const gid = interaction.guildId ?? interaction.guild?.id;
    const reply = (c) => respondPrivate(interaction, c);
    if (!gid || !userId) return reply('Bir sorun oluştu, komutları yazarak kullanabilirsin: `!para`');

    // Blackjack oyun butonları: eko:bj:<hit|stand|double>:<oyuncuID>  (oyun mesajını yerinde günceller)
    if (act === 'bj' && ['hit', 'stand', 'double'].includes(parts[2])) {
      const owner = parts[3];
      if (owner !== String(userId)) return reply('Bu senin oyunun değil. Kendi oyunun için `!blackjack <miktar>` yaz.');
      let r;
      try { r = bjAct(owner, parts[2]); }
      catch (e) { console.warn('[ekonomi] blackjack hatası:', e?.message || e); return reply('Bir hata oluştu, `!hit` / `!stand` ile devam edebilirsin.'); }
      if (r.err) return reply(r.err);
      const payload = r.note ? { ...r.payload, content: r.note.trim() } : r.payload;
      try { return await respondUpdate(interaction, payload); }
      catch (e) { console.warn('[ekonomi] blackjack güncelleme hatası:', e?.message || e); return reply(payload); }
    }

    let fn, args = [];
    if (act === 'slot') { fn = slot; args = [parts[2]]; }
    else if (act === 'yt') { fn = yazitura; args = [parts[2], parts[3]]; }
    else if (act === 'sat') { fn = sat; args = [parts[2]]; }
    else if (act === 'bj') { fn = blackjack; args = [parts[2]]; } // panelden yeni oyun (bahis miktarı)
    else fn = { para, gunluk, calis, av, zoo: hayvanat, zengin }[act];
    if (!fn) return reply('Bu buton tanınmadı, paneli `!ekonomi` ile yeniden aç.');

    let out = null;
    const fake = {
      author: { id: String(userId) }, guildId: String(gid), channelId: interaction.channelId, mentions: null,
      reply: async (p) => { out = p; return p; },
    };
    try { await fn(fake, args); }
    catch (e) { console.warn('[ekonomi] buton hatası:', e?.message || e); out = 'Bir hata oluştu, birazdan tekrar dene.'; }
    return reply(out ?? 'Tamamlandı.');
  }

  // başka bir modülün komutunu ezmemek için çakışmada atlar
    const reg = (names, fn) => {
    for (const n of names) {
      if (Object.hasOwn(commands, n)) { console.warn(`[ekonomi] !${n} başka bir modülde var, atlandı`); continue; }
      commands[n] = (message, args) => fn(bind(message), args);
    }
  };
  reg(['para', 'cash', 'bakiye', 'cuzdan', 'cüzdan', 'bal', 'balance', 'wallet', 'money'], para);
  reg(['gunluk', 'günlük', 'daily'], gunluk);
  reg(['calis', 'çalış', 'work', 'job'], calis);
  reg(['yazitura', 'yazıtura', 'yt', 'cf', 'coinflip', 'flip'], yazitura);
  reg(['slot', 'slots', 'slotmakinesi'], slot);
  reg(['blackjack', 'bj', '21', 'yirmibir'], blackjack);
  reg(['hit', 'cek', 'çek', 'kart'], bjCmd('hit'));
  reg(['stand', 'dur'], bjCmd('stand'));
  reg(['double', 'katla'], bjCmd('double'));
  reg(['av', 'hunt'], av);
  reg(['hayvanat', 'hayvanatbahcesi', 'zoo', 'animals'], hayvanat);
  reg(['sat', 'sell'], sat);
  reg(['gonder', 'gönder', 'give', 'pay', 'send'], gonder);
  // 'top', 'leaderboard', 'lb' bilerek YOK: seviye/mesaj sıralaması gibi diğer modüllerin komutlarıyla çakışıyordu
  reg(['zengin', 'zenginler', 'richest', 'rinecytop'], zengin);
  reg(['ekonomi', 'eko', 'ekonomi-panel', 'ekopanel', 'economy', 'eco'], panel);
  reg(['para-ver', 'give-money', 'addmoney'], paraVer);
  reg(['para-al', 'take-money', 'removemoney'], paraAl);

  // ---------- Yardım sayfası ----------
  HELP_PAGES.economy = () => ({
    title: '💰 Ekonomi Komutları',
    color: COLORS.warn,
    fields: [
      { name: '🧭 Panel', value: '`!ekonomi` (`!economy`, `!eko`) butonlu ekonomi paneli açar', inline: false },
      { name: `${CUR_NAME} Cüzdanı`, value: '`!para [kullanıcı]` (`!bal`, `!cash`, `!wallet`) bakiye, seri, istatistik\n`!gunluk` (`!daily`) günlük ödül (her gün artar)\n`!calis` (`!work`) 30 dk\'da bir iş yap', inline: false },
      { name: '🎰 Kumar', value: `\`!yazitura <miktar> [yazı|tura]\` (\`!cf\`, \`!coinflip\`, \`!yt\`) x2\n\`!slot <miktar>\` ikili x${SLOT_PAIR}, üçlü x3 ile x100\nMiktar yerine \`hepsi\` (\`all\`) ya da \`2k\` yazabilirsin (en fazla ${nf(MAX_BET)})`, inline: false },
      { name: '🃏 Blackjack', value: '`!blackjack <miktar>` (`!bj`, `!21`) oyunu başlatır. Butonlarla ya da `!hit` (kart çek), `!stand` (dur), `!double` (katla) ile oyna.\nKazanırsan x2, blackjack x2.5, beraberlikte bahis iade. Kasa 17\'de durur. 3 dk işlem yapmazsan otomatik "dur" sayılır.', inline: false },
      { name: '🏹 Av', value: `\`!av\` (\`!hunt\`) ${HUNT_COST} ${CUR} karşılığı hayvan yakala\n\`!hayvanat [kullanıcı]\` (\`!zoo\`) koleksiyon\n\`!sat hepsi\` (\`!sell all\`) / \`!sat <nadir|ender|destansı|efsanevi>\``, inline: false },
      { name: '🤝 Sosyal', value: `\`!gonder <kullanıcı> <miktar>\` (\`!give\`, \`!pay\`) günlük en fazla ${nf(SEND_LIMIT)}\n\`!zengin\` (\`!richest\`, \`!rinecytop\`) ilk 10 sıralaması`, inline: false },
    ],
    footer: { text: `Başlangıç parası: ${nf(START)} • Ekonomi tüm sunucularda ortaktır` },
  });

  // ---------- Diğer modüllere açılan köprü (rinae-aile.js nafaka için kullanır) ----------
  // Aile modülü bunu her çağrıda globalThis'ten okuduğu için yükleme sırası fark etmez.
  globalThis.__rinaeEconomy = {
    fmt: (n) => money(n),
    balance: (uid) => U(String(uid)).cash,
    // Günlük !gonder limitine takılmaz. Bakiye yetmezse hiçbir şey yapmaz, { ok: false } döner.
    transfer: (from, to, amount) => {
      const n = Math.floor(Number(amount));
      from = String(from); to = String(to);
      if (!(n >= 1) || from === to) return { ok: false };
      const a = U(from);
      if (a.cash < n) return { ok: false };
      add(a, -n);
      add(U(to), n);
      return { ok: true };
    },
  };

  return { flush, handleInteraction };
}

module.exports = { init };