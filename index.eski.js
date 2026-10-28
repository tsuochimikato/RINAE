// RINAE - Jubbio moderasyon, rol koordinasyonu, kayıt, başvuru, etkinlik ve istatistik botu
// Kurulum: npm install @jubbio/core
// Çalıştırma (PowerShell): $env:BOT_TOKEN="token"; $env:BOT_OWNER_ID="senin_id"; node index.js
//
// Komut grupları (!help ile butonlu menü açılır):
//   Moderasyon : !ban !unban !kick !mute !unmute !timeout !sicil !sicil-sifirla
//   Filtreler  : !filtre (reklam/küfür/spam/caps) !kelime !caps
//   Rol & Log  : !rol-ver !rol-al !log-kanal !log-kapat !log
//   Kayıt      : !kayit !kayit-panel !kayit-ayar !kayit-bilgi !kayit-sil !hosgeldin
//   Topluluk   : !basvuru* (yazılı başvurular) !sikayet* (şikayet/ss kaydı) !event-* (etkinlik takvimi)
//   İstatistik : !server-stats !activity !weekly-report !bot-stats (sadece bot sahibi)
//   Yönetim    : !yetkili-performans !yetkili-liste !yetkili-ekle !haftanin-uyesi !komut-izin
//
// Ortam değişkenleri (PowerShell):
//   $env:DEBUG_MODE="1"      -> ham olaylar ve etkileşim alanları konsola yazılır
//   $env:JOIN_INTENT="1"     -> yeni üye olayı için guildmembers intent'i
//   $env:LOG_CHANNEL_ID="id" -> log kanalı
//   $env:BOT_OWNER_ID="id"   -> !bot-stats komutunu kullanabilecek bot sahibi
// Dosyalar: ayarlar.json (ayarlar), kayitlar.json (kayıtlar), veri.json (yeni özelliklerin verisi)

const fs = require('fs');
const path = require('path');
const core = require('@jubbio/core');
const { Client, GatewayIntentBits, PermissionFlagsBits } = core;

// PowerShell: $env:DEBUG_MODE="1"  -> ham olaylar ve etkileşim alanları konsola yazılır
const DEBUG_MODE = process.env.DEBUG_MODE === '1';

// ---------- Intents ----------
// İsimler büyük/küçük harf ve alt çizgiden bağımsız eşleştirilir (Guilds, GUILD_MESSAGES vb.)
const WANTED_INTENTS = ['guilds', 'guildmessages', 'messagecontent', 'guildmoderation', 'guildbans'];
// Yeni üye katılma olayını almak için gerekebilir. İzin verilmediyse bot 4014 hatasıyla açılmaz,
// bu yüzden sadece istenirse eklenir. PowerShell: $env:JOIN_INTENT="1"
if (process.env.JOIN_INTENT === '1') WANTED_INTENTS.push('guildmembers');
const intents = [];
const pickedNames = [];
for (const [name, value] of Object.entries(GatewayIntentBits || {})) {
  if (typeof value === 'number' && WANTED_INTENTS.includes(name.toLowerCase().replace(/_/g, ''))) {
    intents.push(value);
    pickedNames.push(name);
  }
}
console.log('Seçilen intent\'ler:', pickedNames.join(', ') || '(hiçbiri)');
console.log('Tüm intent adları:', Object.keys(GatewayIntentBits || {}).join(', '));

const client = new Client({ intents });
let ek = null; // ek özellikler modülü (aşağıda başlatılır)

// ---------- Ayarlar ----------
const CONFIG = {
  prefix: '!',
  spam: { enabled: true, maxMessages: 5, windowMs: 5000, timeoutMs: 60_000 },
  bannedWords: [], // !kelime ekle komutuyla doldurulur (ayarlar.json'da saklanır)
  // Küfür cezası: ilk N ihlalde sadece mesaj silinir, sonra kademeli susturma, en sonunda ban
  profanity: {
    enabled: true,
    deleteOnlyCount: 2,
    muteMinutes: [1, 2, 5, 10], // 3. ihlal 1 dk, 4. ihlal 2 dk, 5. ihlal 5 dk, 6. ihlal 10 dk (en yüksek), sonrası ban
    wholeWordOnly: true,        // true: ifade ancak tam olarak geçerse eşleşir. !kelime mod ile değişir
  },
  // Davet linki (reklam) filtresi
  adFilter: {
    enabled: true,
    maxStrikes: 3,            // bu kadar mesaj silinince kalıcı ban
    allowedInviteCodes: [],   // kendi sunucunun davet kodları serbest kalsın istersen: ['abc123']
    allowedUserIds: [],       // filtrelerden muaf kullanıcı ID'leri
  },
  muteDefaultMinutes: 28 * 24 * 60, // !mute süre verilmezse (Jubbio en fazla 28 gün destekliyor)
  logChannelId: process.env.LOG_CHANNEL_ID || null,
};
const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// ---------- Kalıcı durum ----------
const SETTINGS_FILE = path.join(__dirname, 'ayarlar.json');
const RECORDS_FILE = path.join(__dirname, 'kayitlar.json');
let logGuildId = null;     // log kanalının ait olduğu sunucu
const recentLogs = [];     // son log kayıtları (bellekte)
const strikes = {};        // "sunucuID:kullanıcıID" -> küfür ihlal sayısı
const adStrikes = {};      // "sunucuID:kullanıcıID" -> reklam ihlal sayısı

// Kayıt sistemi ayarları (rol ID'leri !kayit-ayar ile girilir)
const REG = {
  guildId: null,
  channelId: null,          // yeni gelenlere hoş geldin mesajı atılacak kanal
  registeredRoleId: null,   // kayıt bitince verilen rol
  unregisteredRoleId: null, // kayıt bitince alınan (ve gelince verilen) rol
  genders: {
    kadin: { label: 'Kadın', roleId: null },
    erkek: { label: 'Erkek', roleId: null },
    diger: { label: 'Belirtmek istemiyorum', roleId: null },
  },
  ages: [
    { label: '18 yaş altı', roleId: null },
    { label: '18-24', roleId: null },
    { label: '25-34', roleId: null },
    { label: '35+', roleId: null },
  ],
  interests: [], // { label, roleId }
};
let regRecords = {};              // "sunucuID:kullanıcıID" -> kayıt bilgisi (kayitlar.json)
const regSessions = new Map();    // doldurulmakta olan formlar (bellekte)

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    if (!process.env.LOG_CHANNEL_ID && data.logChannelId) CONFIG.logChannelId = data.logChannelId;
    if (data.logGuildId) logGuildId = data.logGuildId;
    if (typeof data.adFilterEnabled === 'boolean') CONFIG.adFilter.enabled = data.adFilterEnabled;
    if (typeof data.profanityEnabled === 'boolean') CONFIG.profanity.enabled = data.profanityEnabled;
    if (typeof data.spamEnabled === 'boolean') CONFIG.spam.enabled = data.spamEnabled;
    if (typeof data.wholeWordOnly === 'boolean') CONFIG.profanity.wholeWordOnly = data.wholeWordOnly;
    if (Array.isArray(data.bannedWords)) CONFIG.bannedWords = data.bannedWords;
    if (data.strikes && typeof data.strikes === 'object') Object.assign(strikes, data.strikes);
    if (data.adStrikes && typeof data.adStrikes === 'object') Object.assign(adStrikes, data.adStrikes);
    const r = data.registration;
    if (r && typeof r === 'object') {
      for (const k of ['guildId', 'channelId', 'registeredRoleId', 'unregisteredRoleId']) if (k in r) REG[k] = r[k];
      if (r.genders) {
        for (const k of Object.keys(REG.genders)) if (r.genders[k]) REG.genders[k].roleId = r.genders[k].roleId ?? null;
      }
      if (Array.isArray(r.ages)) {
        REG.ages = r.ages.filter((a) => a && a.label).slice(0, 5)
          .map((a) => ({ label: String(a.label), roleId: a.roleId ?? null }));
      }
      if (Array.isArray(r.interests)) {
        REG.interests = r.interests.filter((a) => a && a.label).slice(0, 10)
          .map((a) => ({ label: String(a.label), roleId: a.roleId ?? null }));
      }
    }
  } catch { /* dosya yoksa sorun değil */ }
}
function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
      logChannelId: CONFIG.logChannelId,
      logGuildId,
      adFilterEnabled: CONFIG.adFilter.enabled,
      profanityEnabled: CONFIG.profanity.enabled,
      spamEnabled: CONFIG.spam.enabled,
      wholeWordOnly: CONFIG.profanity.wholeWordOnly,
      bannedWords: CONFIG.bannedWords,
      strikes,
      adStrikes,
      registration: REG,
    }, null, 2));
  } catch (err) { console.warn('Ayarlar kaydedilemedi:', err.message); }
}
function loadRecords() {
  try { regRecords = JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf-8')) || {}; } catch { regRecords = {}; }
}
function saveRecords() {
  try { fs.writeFileSync(RECORDS_FILE, JSON.stringify(regRecords, null, 2)); }
  catch (err) { console.warn('Kayıtlar kaydedilemedi:', err.message); }
}

// ---------- Yardımcılar ----------
function warn(name, err) {
  console.warn(`[${name}] çalışmadı:`, err?.message || err || 'metot bulunamadı');
}

function guildOf(message) {
  const id = message.guildId || message.guild?.id;
  return id ? client.guilds?.get(id) || message.guild : null;
}
function guildIdOf(message) {
  return message.guildId || message.guild?.id || null;
}

// "<@1017>" veya "<@!1017>" yazılsa bile sadece ID'yi çıkarır
function cleanId(value) {
  return String(value ?? '').replace(/[<@!&#>]/g, '');
}

// Mesajdaki etiketlerden (mentions) gelen kullanıcı ID'leri
function mentionIds(message) {
  const m = message.mentions;
  const out = [];
  if (!m) return out;
  const push = (v) => {
    if (v == null) return;
    if (typeof v === 'object') { if (v.id != null) out.push(String(v.id)); }
    else out.push(String(v));
  };
  const users = m.users ?? m;
  if (Array.isArray(users)) users.forEach(push);
  else if (typeof users?.forEach === 'function') users.forEach((v) => push(v));
  return out;
}

// Yazılan kullanıcı ifadesinden olası tüm ID'ler (yazılan ID + etiketten gelenler)
function resolveUserIds(message, raw) {
  const ids = new Set();
  const cleaned = cleanId(raw);
  if (cleaned) ids.add(cleaned);
  if (String(raw ?? '').includes('<@')) for (const id of mentionIds(message)) ids.add(id);
  return [...ids];
}

const skey = (gid, uid) => `${gid}:${uid}`;

function isOwnerOf(message) {
  const guild = guildOf(message);
  const ownerId = guild?.ownerId ?? guild?.owner_id ?? guild?.ownerID;
  const authorId = message.author?.id;
  return Boolean(ownerId && authorId && String(ownerId) === String(authorId));
}

// Sunucu sahibi, yönetici yetkisi olanlar ve !komut-izin ile yetki verilen roller geçer
async function hasPerm(message, flagName) {
  // 0) !komut-izin ile bu komut için rol izni verilmişse
  if (message.__permOverride) return true;
  // 1) Sunucu sahibi her zaman yetkilidir
  if (isOwnerOf(message)) return true;
  // 2) Yönetici (Administrator) yetkisi olan herkes yetkilidir
  if (ek && (await ek.isAdmin(message))) return true;

  // 3) Diğerleri için yetki bayrağına bak (Jubbio mesajda üye/yetki bilgisi vermiyorsa reddedilir)
  const flag = PermissionFlagsBits?.[flagName];
  const perms = message.member?.permissions;
  if (DEBUG_MODE) {
    console.log('[yetki kontrolü]', {
      authorId: message.author?.id, flagName, flagBulundu: flag !== undefined,
      memberVar: Boolean(message.member), permsTipi: typeof perms,
    });
  }
  if (flag === undefined || !perms) return false;
  if (typeof perms.has === 'function') return perms.has(flag);
  return false;
}

async function requirePerm(message, flagName, text) {
  if (await hasPerm(message, flagName)) return true;
  await message.reply(text);
  return false;
}
const ADMIN_ONLY = 'Bu komut sadece sunucu sahibi/yönetici içindir.';
const FAIL_TEXT = 'İşlem başarısız oldu. Sebep botun konsolunda yazıyor.';

function isExempt(message) {
  return isOwnerOf(message) || CONFIG.adFilter.allowedUserIds.includes(String(message.author?.id));
}

function fmtDuration(min) {
  if (min % 1440 === 0) return `${min / 1440} gün`;
  if (min % 60 === 0) return `${min / 60} saat`;
  return `${min} dakika`;
}

// ---------- Log mesajı yardımcıları ----------
const COLORS = { main: 0x5865f2, ok: 0x57f287, bad: 0xed4245, warn: 0xfee75c };
const who = (id) => '<@' + id + '>\n`' + id + '`';
const ev = (title, color, fields = []) => ({
  title,
  color,
  fields: fields.filter(Boolean).map(([name, value, inline = true]) => ({
    name,
    value: String(value ?? '—').slice(0, 1000) || '—',
    inline,
  })),
});

// ---------- Reklam (davet linki) filtresi ----------
// https://jubbio.com/invite/KOD, jubbio.com/invite/KOD, www.jubbio.com/invite/KOD
const INVITE_REGEX = /(?:https?:\/\/)?(?:www\.)?jubbio\.com\/invite\/([A-Za-z0-9_-]+)/gi;

function findInviteCodes(content) {
  return [...content.matchAll(INVITE_REGEX)].map((m) => m[1]);
}

// ---------- Mesaj gönderme ----------
const plain = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);

// Kanala kanal ID'siyle doğrudan REST üzerinden yazar. Sırayla dener:
// butonlu embed -> butonsuz embed -> düz yazı
async function postToChannel(gid, channelId, payload) {
  if (!gid || !channelId) return false;
  const url = `/bot/guilds/${gid}/channels/${channelId}/messages`;
  const body = { ...payload };
  if (body.components) body.components = body.components.map(plain);
  const attempts = [body];
  if (body.components) attempts.push({ ...body, components: undefined });
  if (body.embeds?.length) attempts.push({ content: embedToText(body.embeds[0]) });
  for (const attempt of attempts) {
    try {
      await client.rest.request('POST', url, JSON.parse(JSON.stringify(attempt)));
      return true;
    } catch (err) {
      warn('mesaj gönderme', err);
    }
  }
  return false;
}

// Komutun yazıldığı kanala düz yazı gönderir
function say(message, text) {
  return postToChannel(guildIdOf(message), message.channelId, { content: text });
}

// ---------- Aksiyonlar ----------
// Gerçek çağrılar @jubbio/core kaynak kodundan alındı (rest.request / rest.kickMember / rest.timeoutMember).
// Her aksiyon başarılıysa true, olmadıysa false döner (sebep konsola yazılır).
async function safe(label, fn) {
  try {
    await fn();
    return true;
  } catch (err) {
    warn(label, err);
    return false;
  }
}

function roleOp(method, guildId, userId, roleId) {
  return safe(method === 'PUT' ? 'addRole' : 'removeRole', () =>
    client.rest.request(method, `/bot/guilds/${guildId}/members/${userId}/roles/${roleId}`));
}

const actions = {
  async deleteMessage(message) {
    return safe('deleteMessage', async () => {
      if (typeof message.delete !== 'function') throw new Error('message.delete yok');
      await message.delete();
    });
  },
  // ms = milisaniye (timeoutMember kaynağında doğrulandı), null = timeout'u kaldır
  timeout(message, userId, ms, reason) {
    return safe('timeout', () => client.rest.timeoutMember(guildIdOf(message), userId, ms, reason));
  },
  untimeout(message, userId, reason) {
    return safe('untimeout', () => client.rest.timeoutMember(guildIdOf(message), userId, null, reason));
  },
  kick(message, userId, reason) {
    return safe('kick', () => client.rest.kickMember(guildIdOf(message), userId, reason));
  },
  ban(message, userId, reason) {
    return safe('ban', () =>
      client.rest.request('PUT', `/bot/guilds/${guildIdOf(message)}/bans/${userId}`, { reason }));
  },
  unban(message, userId) {
    return safe('unban', () =>
      client.rest.request('DELETE', `/bot/guilds/${guildIdOf(message)}/bans/${userId}`));
  },
  addRole(message, userId, roleId) {
    return roleOp('PUT', guildIdOf(message), userId, roleId);
  },
  removeRole(message, userId, roleId) {
    return roleOp('DELETE', guildIdOf(message), userId, roleId);
  },
  // input: düz yazı ya da ev(...) ile hazırlanmış { title, color, fields }
   async log(input, gidOverride) {
    const e = typeof input === 'string' ? { title: input, fields: [] } : input;
    const gid = gidOverride || logCtx.getStore()?.gid || null;
    const when = new Date().toLocaleString('tr-TR');
    const text = `[${when}] ${e.title}` + (e.fields?.length
      ? ' | ' + e.fields.map((f) => `${f.name}: ${String(f.value).replace(/\n/g, ' ')}`).join(' | ')
      : '');
    console.log('[LOG]', gid ? `[${gid}]` : '', text);
    recentLogs.push({ gid, title: e.title, fields: e.fields ?? [], color: e.color, when });
    if (recentLogs.length > 300) recentLogs.shift();
    try {
      const channelId = gid ? logChannels[gid] : null;
      if (!channelId) return; // bu sunucuda log kanalı yoksa sadece konsola yazılır
      await postToChannel(gid, channelId, {
        embeds: [{
          title: e.title,
          color: e.color ?? COLORS.main,
          fields: [...(e.fields ?? []), { name: '🕒 Zaman', value: when, inline: true }],
          footer: { text: 'RINAE • Log' },
          timestamp: new Date().toISOString(),
        }],
      });
    } catch (err) { warn('log', err); }
  },
};

// ---------- Kelime filtresi ----------
const trLower = (t) => String(t ?? '').toLocaleLowerCase('tr-TR');
const normalizePhrase = (t) => trLower(t).replace(/\s+/g, ' ').trim();
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "kelime bir, kelime iki" -> ["kelime bir", "kelime iki"]. Boşluk bırakılan kelimeler TEK ifade sayılır,
// ayırmak için virgül (veya ; |) kullanılır.
function parsePhrases(raw) {
  return String(raw ?? '').split(/[,;|\n]+/).map(normalizePhrase).filter(Boolean);
}

const phraseRegexCache = new Map();
function phraseRegex(phrase) {
  if (!phraseRegexCache.has(phrase)) {
    phraseRegexCache.set(phrase, new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegex(phrase).replace(/ /g, '\\s+')}(?![\\p{L}\\p{N}])`, 'u'));
  }
  return phraseRegexCache.get(phrase);
}

// Mesajda yasaklı ifade varsa o ifadeyi, yoksa null döner. İfade bütün olarak aranır (kelime kelime değil).
function findBannedWord(content) {
  const text = normalizePhrase(content);
  for (const w of CONFIG.bannedWords) {
    if (!w) continue;
    if (CONFIG.profanity.wholeWordOnly) {
      if (phraseRegex(w).test(text)) return w;
    } else if (text.includes(w)) {
      return w;
    }
  }
  return null;
}

// İhlal sayısına göre küfür cezası: uyarı (sadece silme) -> kademeli mute -> ban
function decideProfanityAction(count) {
  const { deleteOnlyCount, muteMinutes } = CONFIG.profanity;
  if (count <= deleteOnlyCount) return { type: 'warn' };
  const step = count - deleteOnlyCount - 1;
  if (step < muteMinutes.length) return { type: 'mute', minutes: muteMinutes[step] };
  return { type: 'ban' };
}

function profanitySummary() {
  const p = CONFIG.profanity;
  return `${p.deleteOnlyCount} uyarı → ${p.muteMinutes.join('/')} dk mute → ban`;
}

async function punishProfanity(message, matchedWord) {
  const gid = guildIdOf(message);
  const uid = String(message.author.id);
  const key = skey(gid, uid);
  const count = (strikes[key] || 0) + 1;
  strikes[key] = count;
  saveSettings();

  const deleted = await actions.deleteMessage(message);
  const tag = `<@${uid}>`;
  const fields = [
    ['Kullanıcı', who(uid)],
    ['İhlal', `${count}. ihlal`],
    ['Kelime', matchedWord],
    ['Mesaj', deleted ? 'Silindi' : 'SİLİNEMEDİ'],
  ];
  const decision = decideProfanityAction(count);

  if (decision.type === 'warn') {
    await actions.log(ev('🤬 Küfür engellendi', COLORS.warn, [...fields, ['İşlem', 'Uyarı']]));
    await say(message, `${tag} küfür yasak. Uyarı ${count}/${CONFIG.profanity.deleteOnlyCount}. Devam edersen susturulacaksın.`);
    return;
  }

  if (decision.type === 'mute') {
    const ok = await actions.timeout(message, uid, decision.minutes * 60_000, `Küfür (${count}. ihlal)`);
    await actions.log(ev('🤬 Küfür: MUTE', COLORS.bad, [
      ...fields, ['İşlem', `${decision.minutes} dk mute ${ok ? 'uygulandı' : 'UYGULANAMADI'}`],
    ]));
    if (ok) await say(message, `${tag} küfür nedeniyle ${decision.minutes} dakika susturuldun.`);
    return;
  }

  const ok = await actions.ban(message, uid, `Tekrarlanan küfür (${count}. ihlal)`);
  await actions.log(ev('🤬 Küfür: BAN', COLORS.bad, [...fields, ['İşlem', ok ? 'Ban uygulandı' : 'Ban UYGULANAMADI']]));
  if (ok) await say(message, `${tag} tekrarlanan küfür nedeniyle sunucudan yasaklandı.`);
}

// Reklam: maxStrikes kadar mesaj silinince kalıcı ban
async function punishAd(message, codes) {
  const gid = guildIdOf(message);
  const uid = String(message.author.id);
  const key = skey(gid, uid);
  const count = (adStrikes[key] || 0) + 1;
  adStrikes[key] = count;
  saveSettings();

  const max = CONFIG.adFilter.maxStrikes;
  const deleted = await actions.deleteMessage(message);
  const tag = `<@${uid}>`;
  const fields = [
    ['Kullanıcı', who(uid)],
    ['İhlal', `${count}/${max}`],
    ['Davet kodu', codes.join(', ')],
    ['Mesaj', deleted ? 'Silindi' : 'SİLİNEMEDİ'],
  ];

  if (count < max) {
    await actions.log(ev('🔗 Reklam engellendi', COLORS.warn, [...fields, ['İşlem', 'Uyarı']]));
    await say(message, `${tag} reklam yapmak yasak. Uyarı ${count}/${max}. ${max}. ihlalde kalıcı olarak yasaklanacaksın.`);
    return;
  }

  const ok = await actions.ban(message, uid, `Reklam (${count}. ihlal)`);
  await actions.log(ev('🔗 Reklam: BAN', COLORS.bad, [...fields, ['İşlem', ok ? 'Ban uygulandı' : 'Ban UYGULANAMADI']]));
  if (ok) await say(message, `${tag} tekrarlanan reklam nedeniyle sunucudan yasaklandı.`);
}

// ---------- Spam ----------
const history = new Map(); // userId -> [zaman damgaları]

function isSpam(userId) {
  const now = Date.now();
  const list = (history.get(userId) || []).filter((t) => now - t < CONFIG.spam.windowMs);
  list.push(now);
  history.set(userId, list);
  return list.length > CONFIG.spam.maxMessages;
}

// ---------- Kayıt sistemi ----------
function regSession(gid, uid) {
  const key = skey(gid, uid);
  if (!regSessions.has(key)) regSessions.set(key, { gender: null, age: null, interests: new Set() });
  return regSessions.get(key);
}

function selectedInterestLabels(session) {
  return [...session.interests].map((i) => REG.interests[i]?.label).filter(Boolean);
}

// Kayıt tamamlanınca: seçilen rolleri verir, eski seçimlerden vazgeçilenleri alır, kaydı saklar
async function completeRegistration(gid, uid) {
  const s = regSession(gid, uid);
  if (!s.gender || s.age == null) return { ok: false, error: 'Cinsiyet ve yaş aralığı seçmelisin.' };
  const gender = REG.genders[s.gender];
  const age = REG.ages[s.age];
  if (!gender || !age) return { ok: false, error: 'Seçimin geçersiz, formu sıfırlayıp tekrar dene.' };

  const wanted = [];
  if (gender.roleId) wanted.push(gender.roleId);
  if (age.roleId) wanted.push(age.roleId);
  for (const i of s.interests) if (REG.interests[i]?.roleId) wanted.push(REG.interests[i].roleId);
  if (REG.registeredRoleId) wanted.push(REG.registeredRoleId);

  const key = skey(gid, uid);
  const old = regRecords[key]?.roleIds ?? [];
  const failed = [];
  for (const r of old.filter((x) => !wanted.includes(x))) {
    if (!(await roleOp('DELETE', gid, uid, r))) failed.push(r);
  }
  for (const r of wanted) {
    if (!(await roleOp('PUT', gid, uid, r))) failed.push(r);
  }
  if (REG.unregisteredRoleId) await roleOp('DELETE', gid, uid, REG.unregisteredRoleId);

  const interests = selectedInterestLabels(s);
  regRecords[key] = {
    userId: uid,
    guildId: gid,
    gender: gender.label,
    ageRange: age.label,
    interests,
    roleIds: wanted.filter((r) => !failed.includes(r)),
    registeredAt: new Date().toISOString(),
  };
  saveRecords();
  regSessions.delete(key);
  return { ok: true, failed, record: regRecords[key] };
}

const recentJoins = new Map();
// Yeni gelen üye: kayıtsız rolü verir, hoş geldin mesajı + "Kayıt Ol" butonu gönderir
async function handleJoin(gid, uid, { dry = false } = {}) {
  const k = skey(gid, uid);
  const now = Date.now();
  if (!dry && recentJoins.has(k) && now - recentJoins.get(k) < 15_000) return; // aynı olayın tekrarını yoksay
  recentJoins.set(k, now);
  ek?.onJoin(gid, dry); // istatistik için

  if (!dry && REG.unregisteredRoleId) await roleOp('PUT', gid, uid, REG.unregisteredRoleId);
  if (REG.channelId) {
    await postToChannel(REG.guildId || gid, REG.channelId, {
      content: `<@${uid}> hoş geldin!`,
      embeds: [{
        title: '👋 Aramıza hoş geldin!',
        description: 'Sunucuya erişmek için aşağıdaki **Kayıt Ol** butonuna bas, cinsiyetini, yaş aralığını ve ilgi alanlarını seç.\nButon çalışmazsa `!kayit` yazabilirsin.',
        color: COLORS.ok,
      }],
      components: [makeRow([{ id: 'ui:reg:start::', label: '📝 Kayıt Ol', style: 'Success' }])],
    });
  }
  await actions.log(ev(dry ? '👋 Hoş geldin mesajı (test)' : '👋 Yeni üye', COLORS.ok, [['Kullanıcı', who(uid)]]));
}

// ---------- Arayüz (embed + buton paneller) ----------
const STYLE_NUM = { Primary: 1, Secondary: 2, Success: 3, Danger: 4 };

// Açılıp kapatılabilen filtreler (caps filtresi ek modül tarafından eklenir)
const FILTERS = {
  reklam: { label: 'Reklam', get: () => CONFIG.adFilter.enabled, set: (v) => { CONFIG.adFilter.enabled = v; } },
  kufur: { label: 'Küfür', get: () => CONFIG.profanity.enabled, set: (v) => { CONFIG.profanity.enabled = v; } },
  spam: { label: 'Spam', get: () => CONFIG.spam.enabled, set: (v) => { CONFIG.spam.enabled = v; } },
};
const FILTER_ALIASES = { reklam: 'reklam', ad: 'reklam', kufur: 'kufur', 'küfür': 'kufur', spam: 'spam' };

function filterEmbed() {
  const on = (v) => (v ? '✅ **Açık**' : '❌ **Kapalı**');
  const sp = CONFIG.spam;
  return {
    title: '🛡️ Filtre Paneli',
    description: 'Filtreleri aşağıdaki butonlarla ya da `!filtre <isim> <aç|kapat>` ile yönetebilirsin.',
    color: COLORS.main,
    fields: [
      { name: '🔗 Reklam', value: `${on(CONFIG.adFilter.enabled)}\nDavet linkleri silinir\n${CONFIG.adFilter.maxStrikes}. ihlalde ban`, inline: true },
      { name: '🤬 Küfür', value: `${on(CONFIG.profanity.enabled)}\n${CONFIG.bannedWords.length} ifade\n${profanitySummary()}`, inline: true },
      { name: '⚡ Spam', value: `${on(sp.enabled)}\n${sp.windowMs / 1000} sn'de ${sp.maxMessages}+ mesaj\n→ ${sp.timeoutMs / 60000} dk mute`, inline: true },
      { name: '📢 Caps', value: `${on(FILTERS.caps?.get())}\nBağırarak yazılanlar silinir`, inline: true },
    ],
    footer: { text: 'Filtre ayarlarını sunucu sahibi ve yöneticiler değiştirebilir' },
    timestamp: new Date().toISOString(),
  };
}

const HELP_PAGES = {
  home: () => ({
    title: '📖 Yardım Menüsü',
    description: 'Aşağıdaki butonlarla kategoriler arasında gezebilirsin.\nKomut öneki: `' + CONFIG.prefix + '`',
    color: COLORS.main,
    fields: [
      { name: '🔨 Moderasyon', value: 'Ban, kick, mute, sicil', inline: true },
      { name: '🛡️ Filtreler', value: 'Reklam, küfür, spam, caps', inline: true },
      { name: '🎭 Rol & Log', value: 'Rol verme/alma, log kanalı', inline: true },
      { name: '📝 Kayıt', value: 'Yeni üye kayıt sistemi', inline: true },
      { name: '🎪 Topluluk', value: 'Başvuru, şikayet, etkinlik', inline: true },
      { name: '📊 İstatistik', value: 'Sunucu raporları, yetkili performansı', inline: true },
      { name: '✨ Genel', value: '`!ping` Bot canlı mı?\n`!id` ID\'ni gösterir\n`!help` Bu menü', inline: false },
    ],
    footer: { text: 'RINAE • Moderasyon Botu' },
  }),
  mod: () => ({
    title: '🔨 Moderasyon Komutları',
    color: COLORS.bad,
    fields: [
      { name: '`!ban <kullanıcı> [sebep]`', value: 'Kişiyi sunucudan yasaklar.', inline: false },
      { name: '`!unban <kullanıcı>`', value: 'Yasağı kaldırır, sicilini sıfırlar.', inline: false },
      { name: '`!kick <kullanıcı> [sebep]`', value: 'Kişiyi sunucudan atar.', inline: false },
      { name: '`!mute <kullanıcı> [dakika] [sebep]`', value: 'Susturur. Süre yazmazsan 28 gün (en uzun süre).', inline: false },
      { name: '`!unmute <kullanıcı>`', value: 'Susturmayı kaldırır.', inline: false },
      { name: '`!timeout <kullanıcı> <dakika> [sebep]`', value: 'Süreli susturma (en fazla 28 gün).', inline: false },
      { name: '`!sicil <kullanıcı>` / `!sicil liste`', value: 'Küfür ve reklam ihlallerini gösterir.', inline: false },
      { name: '`!sicil-sifirla <kullanıcı|hepsi>`', value: 'İhlal kayıtlarını siler.', inline: false },
    ],
    footer: { text: 'Kullanıcı yerine ID yazabilir ya da etiketleyebilirsin' },
  }),
  filter: () => ({
    title: '🛡️ Filtre Komutları',
    color: COLORS.main,
    fields: [
      { name: '`!filtre`', value: 'Filtre panelini açar (buton ile aç/kapat).', inline: false },
      { name: '`!filtre <reklam|küfür|spam|caps|hepsi> <aç|kapat>`', value: 'Filtreyi komutla açar/kapatır.', inline: false },
      { name: '`!kelime ekle <ifade>`', value: 'Boşluklu yazılan ifade TEK ifade sayılır. Birden fazla eklemek için virgülle ayır: `!kelime ekle bir ifade, diğer ifade`', inline: false },
      { name: '`!kelime sil <ifade>` / `!kelime liste`', value: 'Siler / listeyi özel mesajla gönderir.', inline: false },
      { name: '`!kelime temizle`', value: 'Listedeki TÜM ifadeleri siler.', inline: false },
      { name: '`!kelime mod <tam|içeren>`', value: 'Tam: ifade bütün olarak geçmeli. İçeren: başka kelimenin içinde geçse de yakalar.', inline: false },
      { name: '⚖️ Cezalar', value: `Küfür: ${profanitySummary()}\nReklam: ${CONFIG.adFilter.maxStrikes}. ihlalde kalıcı ban`, inline: false },
    ],
    footer: { text: 'Sunucu sahibi ve yöneticiler filtrelere takılmaz' },
  }),
  roles: () => ({
    title: '🎭 Rol & Log Komutları',
    color: COLORS.ok,
    fields: [
      { name: '`!rol-ver <kullanıcı> <rolID>`', value: 'Kullanıcıya rol verir.', inline: false },
      { name: '`!rol-al <kullanıcı> <rolID>`', value: 'Kullanıcıdan rolü alır.', inline: false },
      { name: '`!log-kanal` / `!log-kapat`', value: 'Yazdığın kanalı log kanalı yapar / kapatır.', inline: false },
      { name: '`!log`', value: 'Son 10 log kaydını gösterir.', inline: false },
    ],
    footer: { text: 'Botun rolü, işlem yapılan rollerin üstünde olmalı' },
  }),
  reg: () => ({
    title: '📝 Kayıt Komutları',
    color: COLORS.ok,
    fields: [
      { name: '`!kayit`', value: 'Kayıt formunu açar (herkes kullanabilir).', inline: false },
      { name: '`!kayit-panel`', value: 'Kanala herkesin basabileceği "Kayıt Ol" paneli koyar.', inline: false },
      { name: '`!kayit-ayar`', value: 'Kayıt ayarlarını gösterir ve değiştirir (rol eşleştirmeleri, kanal vb.).', inline: false },
      { name: '`!kayit-bilgi <kullanıcı>`', value: 'Kişinin kayıt bilgisini gösterir.', inline: false },
      { name: '`!kayit-sil <kullanıcı>`', value: 'Kişinin kayıt kaydını siler.', inline: false },
    ],
    footer: { text: 'Roller sadece !kayit-ayar ile tanımlananlardan verilir' },
  }),
};

// Buton satırı: önce kütüphanenin builder'larını dener, olmazsa düz JSON kullanır
function makeRow(defs) {
  try {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = core;
    const row = new ActionRowBuilder();
    row.addComponents(...defs.map((d) =>
      new ButtonBuilder().setCustomId(d.id).setLabel(d.label).setStyle(ButtonStyle?.[d.style] ?? STYLE_NUM[d.style] ?? 1)));
    return row;
  } catch (err) {
    warn('buton oluşturma (düz JSON kullanılacak)', err);
    return {
      type: 1,
      components: defs.map((d) => ({ type: 2, style: STYLE_NUM[d.style] ?? 1, label: d.label, custom_id: d.id })),
    };
  }
}

// Yardım sekmeleri (bir satırda en fazla 5 buton olduğu için satırlara bölünür)
function buildHelp(page, uid) {
  const key = HELP_PAGES[page] ? page : 'home';
  const tabs = [
    ['home', '🏠 Ana'], ['mod', '🔨 Moderasyon'], ['filter', '🛡️ Filtreler'], ['roles', '🎭 Rol & Log'], ['reg', '📝 Kayıt'],
    ['community', '🎪 Topluluk'], ['stats', '📊 İstatistik'],
  ].filter(([k]) => HELP_PAGES[k]);
  const rows = [];
  for (let i = 0; i < tabs.length; i += 5) {
    rows.push(makeRow(tabs.slice(i, i + 5).map(([k, label]) => ({
      id: `ui:help:${k}:${uid}`, label, style: k === key ? 'Primary' : 'Secondary',
    }))));
  }
  return { embeds: [HELP_PAGES[key]()], components: rows };
}

function buildFilters(uid) {
  const row = makeRow(Object.entries(FILTERS).map(([k, f]) => ({
    id: `ui:filter:${k}:${uid}`,
    label: `${f.label}: ${f.get() ? 'Kapat' : 'Aç'}`,
    style: f.get() ? 'Danger' : 'Success',
  })));
  return { embeds: [filterEmbed()], components: [row] };
}

// Kayıt formu: cinsiyet + yaş aralığı + ilgi alanları + tamamla/sıfırla (en fazla 5 satır)
function buildRegistration(gid, uid) {
  const s = regSession(gid, uid);
  const rows = [];
  rows.push(makeRow(Object.entries(REG.genders).map(([k, g]) => ({
    id: `ui:reg:g:${k}:${uid}`, label: g.label, style: s.gender === k ? 'Success' : 'Secondary',
  }))));
  const ages = REG.ages.slice(0, 5);
  if (ages.length) {
    rows.push(makeRow(ages.map((a, i) => ({
      id: `ui:reg:a:${i}:${uid}`, label: a.label, style: s.age === i ? 'Success' : 'Secondary',
    }))));
  }
  const interests = REG.interests.slice(0, 10);
  for (let r = 0; r < interests.length; r += 5) {
    rows.push(makeRow(interests.slice(r, r + 5).map((it, j) => ({
      id: `ui:reg:i:${r + j}:${uid}`, label: it.label, style: s.interests.has(r + j) ? 'Success' : 'Secondary',
    }))));
  }
  rows.push(makeRow([
    { id: `ui:reg:ok::${uid}`, label: '✅ Kaydı Tamamla', style: 'Primary' },
    { id: `ui:reg:reset::${uid}`, label: '↩️ Sıfırla', style: 'Danger' },
  ]));
  const interestText = selectedInterestLabels(s).join(', ') || (REG.interests.length ? 'Seçilmedi' : 'Tanımlı ilgi alanı yok');
  return {
    embeds: [{
      title: '📝 Kayıt Formu',
      description: 'Cinsiyetini ve yaş aralığını seç, istersen ilgi alanlarını işaretle. Bitince **Kaydı Tamamla**\'ya bas.\nSeçili olanlar yeşil görünür.',
      color: COLORS.main,
      fields: [
        { name: '👤 Cinsiyet', value: s.gender ? REG.genders[s.gender].label : 'Seçilmedi', inline: true },
        { name: '🎂 Yaş aralığı', value: s.age != null && REG.ages[s.age] ? REG.ages[s.age].label : 'Seçilmedi', inline: true },
        { name: '🎭 İlgi alanları', value: interestText, inline: false },
      ],
      footer: { text: 'Seçimlerin rol vermek için kullanılır ve yetkililer tarafından görülebilir' },
    }],
    components: rows,
  };
}

function embedToText(embed) {
  const lines = [embed.title, embed.description];
  for (const f of embed.fields ?? []) lines.push(`${f.name}: ${f.value}`);
  if (embed.image?.url) lines.push(embed.image.url);
  return lines.filter(Boolean).join('\n').slice(0, 1900);
}

// Paneli komutun yanıtı olarak gönderir: butonlu embed -> butonsuz embed -> düz yazı
async function sendPanel(message, payload) {
  const attempts = [payload];
  if (payload.components?.length) attempts.push({ embeds: payload.embeds });
  for (const attempt of attempts) {
    try {
      await message.reply(attempt);
      return true;
    } catch (err) {
      warn('panel gönderme', err);
    }
  }
  try { await message.reply(embedToText(payload.embeds[0])); } catch (err) { warn('panel (düz yazı)', err); }
  return false;
}

// Filtreyi açıp kapatır, kalıcı kaydeder ve loglar
async function setFilter(keys, value, actorId) {
  for (const k of keys) FILTERS[k].set(value);
  saveSettings();
  await actions.log(ev(`🛡️ Filtre ${value ? 'açıldı' : 'kapatıldı'}`, value ? COLORS.ok : COLORS.warn, [
    ['Filtre', keys.map((k) => FILTERS[k].label).join(', ')],
    ['Yetkili', who(actorId)],
  ]));
}

// ---------- Komutlar (önek komutları) ----------
const ROLE_ID_RE = /^\d{1,25}$/;
const roleArg = (v) => (['yok', 'sil', 'kapat', '-'].includes(trLower(v)) ? null : cleanId(v));

const commands = {
  async ping(message) {
    await message.reply('Pong!');
  },

  // Etiket ve ID uyuşmazlıklarını görmek için: !id  veya  !id @kişi
  async id(message, args) {
    const lines = [`Senin ID'n: ${message.author?.id}`, `Sunucu ID: ${guildIdOf(message)}`];
    if (args[0]) {
      lines.push(`Yazdığın ID: ${cleanId(args[0])}`);
      const m = mentionIds(message);
      if (m.length) lines.push(`Etiketten gelen ID: ${m.join(', ')}`);
    }
    return message.reply(lines.join('\n'));
  },

  async help(message) {
    return sendPanel(message, buildHelp('home', message.author.id));
  },

  async filtre(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const uid = message.author.id;
    if (!args[0]) return sendPanel(message, buildFilters(uid));

    const name = trLower(args[0]);
    const keys = name === 'hepsi' ? Object.keys(FILTERS) : FILTER_ALIASES[name] ? [FILTER_ALIASES[name]] : null;
    const state = trLower(args[1]);
    const value = ['aç', 'ac', 'aktif', 'on'].includes(state) ? true
      : ['kapat', 'kapa', 'pasif', 'off'].includes(state) ? false : null;
    if (!keys || value === null) {
      return message.reply('Kullanım: !filtre <reklam|küfür|spam|caps|hepsi> <aç|kapat>');
    }
    await setFilter(keys, value, uid);
    return sendPanel(message, buildFilters(uid));
  },

  async reklam(message, args) {
    return commands.filtre(message, args.length ? ['reklam', ...args] : []);
  },

  // Geliştirme komutu: kütüphane nesnelerinin gerçek metot/alan adlarını konsola yazar.
  async inspect(message) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const namesOf = (obj) => {
      const names = new Set();
      let o = obj;
      while (o && o !== Object.prototype) {
        Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
        o = Object.getPrototypeOf(o);
      }
      names.delete('constructor');
      return [...names].join(', ');
    };
    const guild = guildOf(message);
    console.log('===== INSPECT BAŞLANGIÇ =====');
    console.log('[guild]', guild ? namesOf(guild) : '(guild yok)');
    console.log('[guild.members]', guild?.members ? namesOf(guild.members) : '(yok)');
    console.log('[guild.roles]', guild?.roles ? namesOf(guild.roles) : '(yok)');
    console.log('[message.member]', message.member ? namesOf(message.member) : '(yok)');
    console.log('[message.author]', message.author ? namesOf(message.author) : '(yok)');
    console.log('[message]', namesOf(message));
    console.log('[message.mentions]', message.mentions ? JSON.stringify(message.mentions).slice(0, 600) : '(yok)');
    console.log('[client.rest]', namesOf(client.rest));
    for (const fn of ['timeoutMember', 'banMember', 'addMemberRole', 'getMember', 'getRoles']) {
      try {
        console.log(`[${fn} kaynağı]`, String(client.rest[fn]));
      } catch (err) { warn(`kaynak ${fn}`, err); }
    }
    const guildId = guildIdOf(message);
    const cut = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? String(x) : x))?.slice(0, 1500);
    try {
      console.log('[getMember örneği]', cut(await client.rest.getMember(guildId, message.author.id)));
    } catch (err) { warn('getMember örneği', err); }
    try {
      console.log('[getRoles örneği]', cut(await client.rest.getRoles(guildId)));
    } catch (err) { warn('getRoles örneği', err); }
    console.log('===== INSPECT BİTİŞ =====');
    return message.reply('Bilgileri konsola yazdım.');
  },

  // ----- Log -----
  async 'log-kanal'(message) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    CONFIG.logChannelId = message.channelId;
    logGuildId = guildIdOf(message);
    saveSettings();
    await message.reply('Bu kanal artık log kanalı.');
    return actions.log(ev('📌 Log kanalı ayarlandı', COLORS.ok, [['Yetkili', who(message.author.id)]]));
  },
  async 'log-kapat'(message) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    CONFIG.logChannelId = null;
    logGuildId = null;
    saveSettings();
    return message.reply('Log kanalı kapatıldı. Kayıtlar sadece konsola yazılacak.');
  },
  async log(message) {
    if (!(await requirePerm(message, 'Administrator', 'Bu komut için yetkin yok.'))) return;
    if (recentLogs.length === 0) return message.reply('Henüz log kaydı yok.');
    const last = recentLogs.slice(-10).reverse();
    return sendPanel(message, {
      embeds: [{
        title: '📜 Son Loglar',
        color: COLORS.main,
        fields: last.map((l) => ({
          name: `${l.title} • ${l.when}`,
          value: (l.fields.map((f) => `**${f.name}:** ${String(f.value).replace(/\n/g, ' ')}`).join('\n') || '—').slice(0, 1000),
          inline: false,
        })),
        footer: { text: `Son ${last.length} kayıt (yeniden başlatınca sıfırlanır)` },
      }],
    });
  },

  // ----- Moderasyon -----
  async ban(message, args) {
    if (!(await requirePerm(message, 'BanMembers', 'Bunun için Üyeleri Yasakla yetkin olmalı.'))) return;
    const [raw, ...rest] = args;
    const userId = cleanId(raw);
    if (!userId) return message.reply('Kullanım: !ban <kullanıcı> [sebep]');
    const reason = rest.join(' ') || 'Sebep belirtilmedi';
    if (!(await actions.ban(message, userId, reason))) return message.reply(FAIL_TEXT);
    await actions.log(ev('🔨 Ban', COLORS.bad, [
      ['Kullanıcı', who(userId)], ['Yetkili', who(message.author.id)], ['Sebep', reason, false],
    ]));
    return message.reply(`Ban uygulandı: ${userId}`);
  },
  async unban(message, args) {
    if (!(await requirePerm(message, 'BanMembers', 'Bunun için Üyeleri Yasakla yetkin olmalı.'))) return;
    const ids = resolveUserIds(message, args[0]);
    const userId = ids[0];
    if (!userId) return message.reply('Kullanım: !unban <kullanıcı>');
    if (!(await actions.unban(message, userId))) return message.reply(FAIL_TEXT);
    for (const id of ids) {
      delete strikes[skey(guildIdOf(message), id)]; // yasağı kalkan kişinin sicili sıfırlanır
      delete adStrikes[skey(guildIdOf(message), id)];
    }
    saveSettings();
    await actions.log(ev('♻️ Unban', COLORS.ok, [['Kullanıcı', who(userId)], ['Yetkili', who(message.author.id)]]));
    return message.reply(`Yasak kaldırıldı: ${userId}`);
  },
  async kick(message, args) {
    if (!(await requirePerm(message, 'KickMembers', 'Bunun için Üyeleri At yetkin olmalı.'))) return;
    const [raw, ...rest] = args;
    const userId = cleanId(raw);
    if (!userId) return message.reply('Kullanım: !kick <kullanıcı> [sebep]');
    const reason = rest.join(' ') || 'Sebep belirtilmedi';
    if (!(await actions.kick(message, userId, reason))) return message.reply(FAIL_TEXT);
    await actions.log(ev('👢 Kick', COLORS.bad, [
      ['Kullanıcı', who(userId)], ['Yetkili', who(message.author.id)], ['Sebep', reason, false],
    ]));
    return message.reply(`Kick uygulandı: ${userId}`);
  },
  async timeout(message, args) {
    if (!(await requirePerm(message, 'ModerateMembers', 'Bunun için Üyeleri Sustur yetkin olmalı.'))) return;
    const [raw, minutes, ...rest] = args;
    const userId = cleanId(raw);
    const ms = Number(minutes) * 60_000;
    if (!userId || !ms || ms < 0) return message.reply('Kullanım: !timeout <kullanıcı> <dakika> [sebep]');
    if (ms > MAX_TIMEOUT_MS) return message.reply('En fazla 28 gün (40320 dakika) susturabilirsin.');
    const reason = rest.join(' ') || 'Sebep belirtilmedi';
    if (!(await actions.timeout(message, userId, ms, reason))) return message.reply(FAIL_TEXT);
    await actions.log(ev('🔇 Timeout', COLORS.warn, [
      ['Kullanıcı', who(userId)], ['Süre', fmtDuration(Number(minutes))], ['Yetkili', who(message.author.id)], ['Sebep', reason, false],
    ]));
    return message.reply(`Timeout uygulandı: ${userId}`);
  },
  async untimeout(message, args) {
    if (!(await requirePerm(message, 'ModerateMembers', 'Bunun için Üyeleri Sustur yetkin olmalı.'))) return;
    const userId = cleanId(args[0]);
    if (!userId) return message.reply('Kullanım: !untimeout <kullanıcı>');
    if (!(await actions.untimeout(message, userId, 'Susturma kaldırıldı'))) return message.reply(FAIL_TEXT);
    await actions.log(ev('🔊 Susturma kaldırıldı', COLORS.ok, [['Kullanıcı', who(userId)], ['Yetkili', who(message.author.id)]]));
    return message.reply(`Susturma kaldırıldı: ${userId}`);
  },
  // !mute <kullanıcı> [dakika] [sebep]  (süre yazılmazsa en uzun süre: 28 gün)
  async mute(message, args) {
    if (!(await requirePerm(message, 'ModerateMembers', 'Bunun için Üyeleri Sustur yetkin olmalı.'))) return;
    const [raw, second, ...rest] = args;
    const userId = cleanId(raw);
    if (!userId) return message.reply('Kullanım: !mute <kullanıcı> [dakika] [sebep]');
    let minutes = CONFIG.muteDefaultMinutes;
    let reasonParts = [second, ...rest];
    if (second !== undefined && /^\d+$/.test(second)) {
      minutes = Number(second);
      reasonParts = rest;
    }
    if (minutes <= 0) return message.reply('Süre 0\'dan büyük olmalı.');
    if (minutes * 60_000 > MAX_TIMEOUT_MS) return message.reply('En fazla 28 gün (40320 dakika) susturabilirsin.');
    const reason = reasonParts.filter(Boolean).join(' ') || 'Sebep belirtilmedi';
    if (!(await actions.timeout(message, userId, minutes * 60_000, reason))) return message.reply(FAIL_TEXT);
    await actions.log(ev('🔇 Mute', COLORS.warn, [
      ['Kullanıcı', who(userId)], ['Süre', fmtDuration(minutes)], ['Yetkili', who(message.author.id)], ['Sebep', reason, false],
    ]));
    return message.reply(`${userId} ${fmtDuration(minutes)} susturuldu.`);
  },
  async unmute(message, args) {
    return commands.untimeout(message, args);
  },
  async 'rol-ver'(message, args) {
    if (!(await requirePerm(message, 'ManageRoles', 'Bunun için Rolleri Yönet yetkin olmalı.'))) return;
    const [rawId, rawRole] = args;
    const userId = cleanId(rawId);
    const roleId = cleanId(rawRole);
    if (!userId || !roleId) return message.reply('Kullanım: !rol-ver <kullanıcı> <rolID>');
    if (!(await actions.addRole(message, userId, roleId))) return message.reply(FAIL_TEXT);
    await actions.log(ev('🎭 Rol verildi', COLORS.ok, [
      ['Kullanıcı', who(userId)], ['Rol', '`' + roleId + '`'], ['Yetkili', who(message.author.id)],
    ]));
    return message.reply('Rol verildi.');
  },
  async 'rol-al'(message, args) {
    if (!(await requirePerm(message, 'ManageRoles', 'Bunun için Rolleri Yönet yetkin olmalı.'))) return;
    const [rawId, rawRole] = args;
    const userId = cleanId(rawId);
    const roleId = cleanId(rawRole);
    if (!userId || !roleId) return message.reply('Kullanım: !rol-al <kullanıcı> <rolID>');
    if (!(await actions.removeRole(message, userId, roleId))) return message.reply(FAIL_TEXT);
    await actions.log(ev('🎭 Rol alındı', COLORS.warn, [
      ['Kullanıcı', who(userId)], ['Rol', '`' + roleId + '`'], ['Yetkili', who(message.author.id)],
    ]));
    return message.reply('Rol alındı.');
  },

  // ----- Yasaklı ifadeler -----
  async kelime(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const sub = trLower(args[0]);
    const rest = args.slice(1).join(' ');

    if (sub === 'ekle') {
      const phrases = parsePhrases(rest);
      if (phrases.length === 0) return message.reply('Kullanım: !kelime ekle <ifade>  (birden fazla için virgülle ayır)');
      let added = 0;
      for (const p of phrases) if (!CONFIG.bannedWords.includes(p)) { CONFIG.bannedWords.push(p); added++; }
      saveSettings();
      await actions.log(ev('📝 Yasaklı ifade eklendi', COLORS.ok, [
        ['Eklenen', `${added} ifade`], ['Toplam', CONFIG.bannedWords.length], ['Yetkili', who(message.author.id)],
      ]));
      await actions.deleteMessage(message); // komut mesajı ifadeyi herkese göstermesin
      return say(message, `${added} ifade eklendi. Listede toplam ${CONFIG.bannedWords.length} ifade var.`);
    }

    if (sub === 'sil' || sub === 'çıkar' || sub === 'cikar') {
      const phrases = parsePhrases(rest);
      if (phrases.length === 0) return message.reply('Kullanım: !kelime sil <ifade>  (birden fazla için virgülle ayır)');
      const before = CONFIG.bannedWords.length;
      CONFIG.bannedWords = CONFIG.bannedWords.filter((w) => !phrases.includes(w));
      const removed = before - CONFIG.bannedWords.length;
      saveSettings();
      await actions.log(ev('📝 Yasaklı ifade silindi', COLORS.warn, [
        ['Silinen', `${removed} ifade`], ['Kalan', CONFIG.bannedWords.length], ['Yetkili', who(message.author.id)],
      ]));
      await actions.deleteMessage(message);
      return say(message, `${removed} ifade silindi. Listede toplam ${CONFIG.bannedWords.length} ifade kaldı.`);
    }

    if (sub === 'temizle') {
      const count = CONFIG.bannedWords.length;
      CONFIG.bannedWords = [];
      saveSettings();
      await actions.log(ev('🧹 Yasaklı ifade listesi temizlendi', COLORS.bad, [
        ['Silinen', `${count} ifade`], ['Yetkili', who(message.author.id)],
      ]));
      return message.reply(`Listedeki ${count} ifadenin hepsi silindi.`);
    }

    if (sub === 'mod') {
      const m = trLower(args[1]);
      if (['tam', 'tamkelime'].includes(m)) CONFIG.profanity.wholeWordOnly = true;
      else if (['içeren', 'iceren', 'icerir', 'içerir'].includes(m)) CONFIG.profanity.wholeWordOnly = false;
      else {
        return message.reply(`Eşleştirme modu şu an: ${CONFIG.profanity.wholeWordOnly ? 'TAM' : 'İÇEREN'}\nKullanım: !kelime mod <tam|içeren>`);
      }
      saveSettings();
      await actions.log(ev('⚙️ Eşleştirme modu değişti', COLORS.warn, [
        ['Mod', CONFIG.profanity.wholeWordOnly ? 'Tam' : 'İçeren'], ['Yetkili', who(message.author.id)],
      ]));
      return message.reply(`Eşleştirme modu: ${CONFIG.profanity.wholeWordOnly ? 'TAM (ifade bütün olarak geçmeli)' : 'İÇEREN (başka kelimenin içinde de yakalar)'}`);
    }

    if (sub === 'liste') {
      if (CONFIG.bannedWords.length === 0) return message.reply('Yasaklı ifade listesi boş.');
      const text = `Yasaklı ifadeler (${CONFIG.bannedWords.length}), mod: ${CONFIG.profanity.wholeWordOnly ? 'tam' : 'içeren'}\n` +
        CONFIG.bannedWords.map((w, i) => `${i + 1}. ${w}`).join('\n');
      try {
        await message.author.send(text.length > 1800 ? text.slice(0, 1800) : text);
        return message.reply('Listeyi sana özel mesajla gönderdim.');
      } catch {
        return message.reply('Özel mesaj gönderemedim, DM\'lerin kapalı olabilir. Listeyi kanala yazmıyorum.');
      }
    }

    return message.reply('Kullanım: !kelime ekle <ifade> | !kelime sil <ifade> | !kelime liste | !kelime temizle | !kelime mod <tam|içeren>');
  },

  // ----- Sicil -----
  async sicil(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const gid = guildIdOf(message);

    if (trLower(args[0]) === 'liste') {
      const ids = new Set();
      for (const store of [strikes, adStrikes]) {
        for (const k of Object.keys(store)) if (k.startsWith(`${gid}:`)) ids.add(k.slice(gid.length + 1));
      }
      if (ids.size === 0) return message.reply('Kayıtlı ihlal yok.');
      const fields = [...ids].slice(0, 20).map((id) => ({
        name: `ID ${id}`,
        value: `🤬 Küfür: ${strikes[skey(gid, id)] || 0} • 🔗 Reklam: ${adStrikes[skey(gid, id)] || 0}/${CONFIG.adFilter.maxStrikes}`,
        inline: false,
      }));
      return sendPanel(message, { embeds: [{ title: '📋 Sicil Listesi', color: COLORS.main, fields, footer: { text: `${ids.size} kullanıcı` } }] });
    }

    const ids = resolveUserIds(message, args[0]);
    if (ids.length === 0) return message.reply('Kullanım: !sicil <kullanıcı>  |  !sicil liste');
    const found = ids.find((id) => strikes[skey(gid, id)] || adStrikes[skey(gid, id)]) ?? ids[0];
    const profCount = strikes[skey(gid, found)] || 0;
    const adCount = adStrikes[skey(gid, found)] || 0;
    const next = decideProfanityAction(profCount + 1);
    const nextText = next.type === 'warn' ? 'Uyarı (mesaj silinir)'
      : next.type === 'mute' ? `${next.minutes} dk mute` : 'BAN';
    return sendPanel(message, {
      embeds: [{
        title: '📋 Sicil',
        color: COLORS.main,
        fields: [
          { name: 'Kullanıcı', value: who(found), inline: true },
          { name: '🤬 Küfür ihlali', value: `${profCount}\nSıradaki: ${nextText}`, inline: true },
          { name: '🔗 Reklam ihlali', value: `${adCount}/${CONFIG.adFilter.maxStrikes}\n${adCount >= CONFIG.adFilter.maxStrikes - 1 ? 'Sıradaki: BAN' : 'Sıradaki: Uyarı'}`, inline: true },
          { name: 'Aranan ID\'ler', value: ids.map((i) => '`' + i + '`').join(', '), inline: false },
        ],
      }],
    });
  },
  async 'sicil-sifirla'(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const gid = guildIdOf(message);

    if (trLower(args[0]) === 'hepsi') {
      let removed = 0;
      for (const store of [strikes, adStrikes]) {
        for (const k of Object.keys(store)) if (k.startsWith(`${gid}:`)) { delete store[k]; removed++; }
      }
      saveSettings();
      await actions.log(ev('🧹 Tüm sicil kayıtları silindi', COLORS.bad, [['Silinen kayıt', removed], ['Yetkili', who(message.author.id)]]));
      return message.reply(`Tüm sicil kayıtları silindi (${removed} kayıt).`);
    }

    const ids = resolveUserIds(message, args[0]);
    if (ids.length === 0) return message.reply('Kullanım: !sicil-sifirla <kullanıcı|hepsi>');
    let removed = 0;
    for (const id of ids) {
      for (const store of [strikes, adStrikes]) {
        if (store[skey(gid, id)] !== undefined) { delete store[skey(gid, id)]; removed++; }
      }
    }
    saveSettings();
    await actions.log(ev('🧹 Sicil sıfırlandı', COLORS.warn, [
      ['Kullanıcı', who(ids[0])], ['Silinen kayıt', removed], ['Yetkili', who(message.author.id)],
    ]));
    return message.reply(removed
      ? `Sicil sıfırlandı (${removed} kayıt silindi).`
      : `Bu kullanıcı için kayıtlı ihlal bulunamadı. Aranan ID: ${ids.join(', ')}. Kayıtlı olanları görmek için: !sicil liste`);
  },

  // ----- Kayıt sistemi -----
  async kayit(message) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    return sendPanel(message, buildRegistration(gid, String(message.author.id)));
  },
  async 'kayit-panel'(message) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    return sendPanel(message, {
      embeds: [{
        title: '📝 Kayıt Ol',
        description: 'Sunucuya erişmek için aşağıdaki butona bas, cinsiyetini, yaş aralığını ve ilgi alanlarını seç.',
        color: COLORS.ok,
      }],
      components: [makeRow([{ id: 'ui:reg:start::', label: '📝 Kayıt Ol', style: 'Success' }])],
    });
  },
  async 'kayit-bilgi'(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const gid = guildIdOf(message);
    const ids = resolveUserIds(message, args[0]);
    const id = ids.find((i) => regRecords[skey(gid, i)]);
    if (!id) return message.reply('Bu kullanıcı için kayıt bulunamadı.');
    const r = regRecords[skey(gid, id)];
    return sendPanel(message, {
      embeds: [{
        title: '📝 Kayıt Bilgisi',
        color: COLORS.main,
        fields: [
          { name: 'Kullanıcı', value: who(id), inline: true },
          { name: 'Cinsiyet', value: r.gender, inline: true },
          { name: 'Yaş aralığı', value: r.ageRange, inline: true },
          { name: 'İlgi alanları', value: r.interests.join(', ') || '—', inline: false },
          { name: 'Kayıt zamanı', value: new Date(r.registeredAt).toLocaleString('tr-TR'), inline: false },
        ],
      }],
    });
  },
  async 'kayit-sil'(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const gid = guildIdOf(message);
    const ids = resolveUserIds(message, args[0]);
    const id = ids.find((i) => regRecords[skey(gid, i)]);
    if (!id) return message.reply('Bu kullanıcı için kayıt bulunamadı.');
    delete regRecords[skey(gid, id)];
    saveRecords();
    await actions.log(ev('🗑️ Kayıt silindi', COLORS.warn, [['Kullanıcı', who(id)], ['Yetkili', who(message.author.id)]]));
    return message.reply('Kayıt silindi. (Kullanıcının mevcut rollerine dokunulmadı.)');
  },
  async 'kayit-ayar'(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const sub = trLower(args[0]);
    const usage = [
      '`!kayit-ayar goster`',
      '`!kayit-ayar kayitli <rolID|yok>`: kayıt bitince verilen rol',
      '`!kayit-ayar kayitsiz <rolID|yok>`: gelince verilen, kayıt bitince alınan rol',
      '`!kayit-ayar cinsiyet <kadin|erkek|diger> <rolID|yok>`',
      '`!kayit-ayar yas <aralık> <rolID|yok>` / `yas-ekle <aralık>` / `yas-sil <aralık>`',
      '`!kayit-ayar ilgi-ekle <etiket> <rolID>` / `ilgi-sil <etiket>`',
      '`!kayit-ayar kanal`: hoş geldin mesajı bu kanala atılsın',
      '`!kayit-ayar test`: hoş geldin mesajını dener',
    ].join('\n');

    const checkRole = (value) => {
      if (value === null) return true; // "yok"
      return ROLE_ID_RE.test(String(value));
    };

    if (sub === 'kayitli' || sub === 'kayıtlı') {
      const v = roleArg(args[1]);
      if (args[1] === undefined || !checkRole(v)) return message.reply('Kullanım: !kayit-ayar kayitli <rolID|yok>');
      REG.registeredRoleId = v;
    } else if (sub === 'kayitsiz' || sub === 'kayıtsız') {
      const v = roleArg(args[1]);
      if (args[1] === undefined || !checkRole(v)) return message.reply('Kullanım: !kayit-ayar kayitsiz <rolID|yok>');
      REG.unregisteredRoleId = v;
    } else if (sub === 'cinsiyet') {
      const alias = { kadin: 'kadin', kadın: 'kadin', erkek: 'erkek', diger: 'diger', diğer: 'diger' };
      const key = alias[trLower(args[1])];
      const v = roleArg(args[2]);
      if (!key || args[2] === undefined || !checkRole(v)) return message.reply('Kullanım: !kayit-ayar cinsiyet <kadin|erkek|diger> <rolID|yok>');
      REG.genders[key].roleId = v;
    } else if (sub === 'yas' || sub === 'yaş') {
      const v = roleArg(args[args.length - 1]);
      const label = args.slice(1, -1).join(' ');
      const age = REG.ages.find((a) => normalizePhrase(a.label) === normalizePhrase(label));
      if (!age || args.length < 3 || !checkRole(v)) return message.reply('Kullanım: !kayit-ayar yas <aralık> <rolID|yok>\nMevcut aralıklar: ' + REG.ages.map((a) => a.label).join(', '));
      age.roleId = v;
    } else if (sub === 'yas-ekle' || sub === 'yaş-ekle') {
      const label = args.slice(1).join(' ').trim();
      if (!label || label.length > 30) return message.reply('Kullanım: !kayit-ayar yas-ekle <aralık>  (en fazla 30 karakter)');
      if (REG.ages.length >= 5) return message.reply('En fazla 5 yaş aralığı olabilir.');
      if (REG.ages.some((a) => normalizePhrase(a.label) === normalizePhrase(label))) return message.reply('Bu aralık zaten var.');
      REG.ages.push({ label, roleId: null });
    } else if (sub === 'yas-sil' || sub === 'yaş-sil') {
      const label = args.slice(1).join(' ');
      const before = REG.ages.length;
      REG.ages = REG.ages.filter((a) => normalizePhrase(a.label) !== normalizePhrase(label));
      if (REG.ages.length === before) return message.reply('Bu aralık bulunamadı.');
    } else if (sub === 'ilgi-ekle') {
      const roleId = cleanId(args[args.length - 1]);
      const label = args.slice(1, -1).join(' ').trim();
      if (!label || label.length > 30 || !ROLE_ID_RE.test(roleId)) return message.reply('Kullanım: !kayit-ayar ilgi-ekle <etiket> <rolID>');
      if (REG.interests.length >= 10) return message.reply('En fazla 10 ilgi alanı olabilir.');
      if (REG.interests.some((a) => normalizePhrase(a.label) === normalizePhrase(label))) return message.reply('Bu ilgi alanı zaten var.');
      REG.interests.push({ label, roleId });
    } else if (sub === 'ilgi-sil') {
      const label = args.slice(1).join(' ');
      const before = REG.interests.length;
      REG.interests = REG.interests.filter((a) => normalizePhrase(a.label) !== normalizePhrase(label));
      if (REG.interests.length === before) return message.reply('Bu ilgi alanı bulunamadı.');
    } else if (sub === 'kanal') {
      REG.channelId = message.channelId;
      REG.guildId = guildIdOf(message);
    } else if (sub === 'test') {
      await handleJoin(guildIdOf(message), String(message.author.id), { dry: true });
      return message.reply('Hoş geldin mesajını test olarak gönderdim (rol değişikliği yapılmadı).');
    } else if (sub !== 'goster' && sub !== 'göster') {
      return sendPanel(message, { embeds: [{ title: '⚙️ Kayıt Ayarı Kullanımı', description: usage, color: COLORS.main }] });
    }

    saveSettings();
    const r = (id) => (id ? '`' + id + '`' : 'Tanımsız');
    return sendPanel(message, {
      embeds: [{
        title: '⚙️ Kayıt Ayarları',
        color: COLORS.main,
        fields: [
          { name: 'Kayıtlı rolü', value: r(REG.registeredRoleId), inline: true },
          { name: 'Kayıtsız rolü', value: r(REG.unregisteredRoleId), inline: true },
          { name: 'Hoş geldin kanalı', value: REG.channelId ? '`' + REG.channelId + '`' : 'Tanımsız', inline: true },
          { name: '👤 Cinsiyet rolleri', value: Object.values(REG.genders).map((g) => `${g.label}: ${r(g.roleId)}`).join('\n'), inline: false },
          { name: '🎂 Yaş aralıkları', value: REG.ages.map((a) => `${a.label}: ${r(a.roleId)}`).join('\n') || 'Yok', inline: false },
          { name: '🎭 İlgi alanları', value: REG.interests.map((a) => `${a.label}: ${r(a.roleId)}`).join('\n') || 'Yok', inline: false },
        ],
        footer: { text: 'Rol ID\'sini "yok" yazarak kaldırabilirsin' },
      }],
    });
  },
};
commands['yardım'] = commands.help;
commands.yardim = commands.help;
commands.filtreler = commands.filtre;
commands['kayıt'] = commands.kayit;
commands['kayıt-panel'] = commands['kayit-panel'];
commands['kayıt-ayar'] = commands['kayit-ayar'];
commands['kayıt-bilgi'] = commands['kayit-bilgi'];
commands['kayıt-sil'] = commands['kayit-sil'];

// ================= EK ÖZELLİKLER MODÜLÜ (aynı dosyada) =================
const FILE = path.join(__dirname, 'veri.json');
const TR = 3 * 3600e3; // Türkiye saati (UTC+3)
const DAY = 864e5;

function initEk(ctx) {
  const {
    client, core, CONFIG, FILTERS, FILTER_ALIASES, HELP_PAGES, commands, actions,
    postToChannel, say, makeRow, sendPanel, requirePerm, ev, who, COLORS, cleanId,
    resolveUserIds, trLower: T, guildIdOf, isOwnerOf, roleOp, getRegRecords,
    respondUpdate, respondPrivate,
  } = ctx;

  // ================= Kalıcı veri =================
  const DEF = () => ({
    capsEnabled: true,
    caps: { minLetters: 8, ratio: 0.7 },
    cmdRoles: {},
    welcome: {
      enabled: true, channelId: null, guildId: null, gifs: [],
      messages: [
        '{user} aramıza katıldı! 🌸 Hoş geldin, kendini evinde hisset~',
        'Yeni bir yüz daha! 💖 Hoş geldin {user}, {server} ailesine katılmana çok sevindik!',
        '{user} geldi, ortam şenlendi! ✨ Hoş geldin tatlım, bol sohbetler~',
        'Hoş geldin {user}! 🌷 Çay kahve hazır, sohbet başlasın!',
      ],
    },
    welcomed: {},
    stats: {},
    cmds: { total: 0, err: 0, byName: {} },
    up: { first: null, total: 0, days: {} },
    staff: {},
    apps: { types: {}, subs: [], nextId: 1 },
    reports: { channelId: null, guildId: null, pingRoleId: null, list: [], nextId: 1 },
    events: { channelId: null, guildId: null, list: [], nextId: 1, reminderMins: [60, 10] },
    attendance: [],
    weights: { msg: 1, event: 30, report: 50, msgCap: 300 },
    motw: { channelId: null, guildId: null, roleId: null, lastUserId: null, history: [] },
    weeklyReport: { channelId: null, guildId: null, lastSent: 0 },
  });
  function load() {
    const def = DEF();
    try {
      const j = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
      for (const k of Object.keys(def)) {
        const v = j[k];
        if (v === undefined) continue;
        def[k] = (def[k] && typeof def[k] === 'object' && !Array.isArray(def[k])) ? { ...def[k], ...v } : v;
      }
    } catch { /* ilk çalıştırma */ }
    return def;
  }
  const D = load();
  let dirty = false;
  const touch = () => { dirty = true; };
  function flush() {
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(FILE, JSON.stringify(D, null, 2)); }
    catch (err) { console.warn('veri.json kaydedilemedi:', err.message); }
  }
  const save = () => { touch(); flush(); };
  setInterval(flush, 20_000).unref?.();
  let messagesSeen = 0;
  const startedAt = Date.now();

  // ================= Küçük yardımcılar =================
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const cut = (v, n = 1000) => String(v ?? '—').slice(0, n) || '—';
  const dayKey = (t = Date.now()) => new Date(t + TR).toISOString().slice(0, 10);
  const hourOf = (t = Date.now()) => new Date(t + TR).getUTCHours();
  const lastDays = (n, end = Date.now()) => Array.from({ length: n }, (_, i) => dayKey(end - (n - 1 - i) * DAY));
  const fmtTime = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const bar = (v, max, len = 12) => '█'.repeat(max ? Math.round((v / max) * len) : 0) || '▏';
  const isId = (v) => /^\d{1,25}$/.test(String(v ?? ''));
  const mentionRole = (id) => `<@&${id}>`;
  const ADMIN_ONLY = 'Bu komut sadece sunucu sahibi/yöneticiler içindir.';
  const needAdmin = (message) => requirePerm(message, 'Administrator', ADMIN_ONLY);
  const uidOf = (m) => String(m.author.id);
  const emb = (title, color, fields = [], description) => ({
    title, color, description,
    fields: fields.filter(Boolean).map(([name, value, inline = true]) => ({ name, value: cut(value), inline })),
  });
  const fmtDur = (ms) => {
    const m = Math.floor(ms / 60000);
    const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
    return [d ? `${d} gün` : '', h ? `${h} sa` : '', `${mi} dk`].filter(Boolean).join(' ');
  };

  // ================= Yönetici kontrolü =================
  const toBig = (v) => {
    try {
      if (typeof v === 'bigint') return v;
      if (v == null) return 0n;
      if (typeof v === 'object') v = v.bitfield ?? v.permissions ?? 0;
      return BigInt(v);
    } catch { return 0n; }
  };
  const ADMIN_BIT = toBig(core.PermissionFlagsBits?.Administrator ?? 8n);
  const adminCache = new Map();
  const rolesCache = new Map();

  async function getRoleList(gid) {
    const c = rolesCache.get(gid);
    if (c && Date.now() - c.t < 60_000) return c.v;
    let list = [];
    try {
      const r = await client.rest.getRoles(gid);
      list = Array.isArray(r) ? r : (Array.isArray(r?.roles) ? r.roles : Object.values(r || {}));
    } catch { /* yetkisiz / metot yok */ }
    rolesCache.set(gid, { t: Date.now(), v: list });
    return list;
  }

  async function memberRoleIds(gid, uid, message) {
    const out = new Set();
    const add = (v) => {
      if (v == null) return;
      if (typeof v === 'object') { if (v.id != null) out.add(String(v.id)); } else out.add(String(v));
    };
    const eat = (r) => {
      if (!r) return;
      if (Array.isArray(r)) r.forEach(add);
      else if (r.cache && typeof r.cache.forEach === 'function') r.cache.forEach((v, k) => add(v?.id ?? k));
      else if (typeof r.forEach === 'function') r.forEach((v, k) => add(v?.id ?? k));
    };
    const m = message?.member;
    eat(m?.roles ?? m?.roleIds ?? m?.role_ids);
    if (out.size === 0) {
      try {
        const mem = await client.rest.getMember(gid, uid);
        eat(mem?.roles ?? mem?.role_ids ?? mem?.member?.roles);
      } catch { /* yoksay */ }
    }
    return out;
  }

  async function isAdminCore(gid, uid, message) {
    if (!gid || !uid) return false;
    const guild = client.guilds?.get(gid);
    const ownerId = guild?.ownerId ?? guild?.owner_id ?? guild?.ownerID;
    if (ownerId && String(ownerId) === String(uid)) return true;

    const ck = `${gid}:${uid}`;
    const c = adminCache.get(ck);
    if (c && Date.now() - c.t < 60_000) return c.v;

    let result = false;
    try {
      const perms = message?.member?.permissions;
      if (perms) {
        if (typeof perms.has === 'function' && core.PermissionFlagsBits?.Administrator !== undefined) {
          result = Boolean(perms.has(core.PermissionFlagsBits.Administrator));
        }
        if (!result) result = (toBig(perms) & ADMIN_BIT) === ADMIN_BIT && toBig(perms) !== 0n;
      }
      if (!result) {
        const mine = await memberRoleIds(gid, uid, message);
        mine.add(String(gid)); // @everyone rolü
        const roles = await getRoleList(gid);
        result = roles.some((r) => mine.has(String(r.id)) && (toBig(r.permissions) & ADMIN_BIT) === ADMIN_BIT);
      }
    } catch { result = false; }
    adminCache.set(ck, { t: Date.now(), v: result });
    return result;
  }
  const isAdmin = (message) => isAdminCore(guildIdOf(message), message.author?.id && String(message.author.id), message);
  const exempt = async (message) =>
    isOwnerOf(message) || CONFIG.adFilter.allowedUserIds.includes(String(message.author?.id)) || (await isAdmin(message));

  // ================= Komut izin yöneticisi =================
  const canonOf = (n) => {
    n = T(n);
    if (!Object.hasOwn(commands, n)) return null;
    return Object.keys(commands).find((k) => commands[k] === commands[n]);
  };

  async function canRun(message, key) {
    const canon = canonOf(key) ?? key;
    const roles = D.cmdRoles[canon];
    if (!roles || canon === 'komut-izin') return true;
    if (isOwnerOf(message) || (await isAdmin(message))) return true;
    if (roles.length) {
      const mine = await memberRoleIds(guildIdOf(message), uidOf(message), message);
      if (roles.some((r) => mine.has(String(r)))) { message.__permOverride = true; return true; }
    }
    await message.reply('Bu komutu kullanma iznin yok.');
    return false;
  }
  function cmdDone(key, ok) {
    const canon = canonOf(key) ?? key;
    D.cmds.total++;
    if (!ok) D.cmds.err++;
    D.cmds.byName[canon] = (D.cmds.byName[canon] || 0) + 1;
    touch();
  }

  // ================= İstatistik altyapısı =================
  function gd(gid, key = dayKey()) {
    const g = (D.stats[gid] ||= { daily: {} });
    return (g.daily[key] ||= { m: 0, j: 0, r: 0, rep: 0, mod: 0, h: Array(24).fill(0), u: {} });
  }
  function sumDays(gid, days, field) {
    return days.reduce((a, k) => a + (D.stats[gid]?.daily?.[k]?.[field] || 0), 0);
  }
  function countMessage(message) {
    const gid = guildIdOf(message);
    if (!gid) return;
    const d = gd(gid);
    const uid = uidOf(message);
    d.m++;
    d.h[hourOf()]++;
    d.u[uid] = (d.u[uid] || 0) + 1;
    messagesSeen++;
    touch();
  }
  function onJoin(gid, dry) {
    if (dry) return;
    gd(gid).j++;
    touch();
  }

  // ================= Yetkili performansı =================
  const MOD_TYPES = ['ban', 'kick', 'mute', 'unmute', 'unban'];
  function staffRec(gid, uid) {
    const k = `${gid}:${uid}`;
    return (D.staff[k] ||= { since: Date.now(), ban: 0, kick: 0, mute: 0, unmute: 0, unban: 0, report: 0, app: 0, role: 0 });
  }
  function trackStaff(gid, uid, type) {
    staffRec(gid, uid)[type]++;
    if (MOD_TYPES.includes(type)) gd(gid).mod++;
    touch();
  }
  // Sadece KOMUTLA yapılan işlemler sayılır (otomatik filtre cezaları sayılmaz)
  const ACTION_MAP = { ban: 'ban', kick: 'kick', timeout: 'mute', untimeout: 'unmute', unban: 'unban', addRole: 'role', removeRole: 'role' };
  for (const [fn, type] of Object.entries(ACTION_MAP)) {
    const orig = actions[fn].bind(actions);
    actions[fn] = async (message, ...rest) => {
      const ok = await orig(message, ...rest);
      if (ok && message?.__cmd && message.author?.id) trackStaff(guildIdOf(message), uidOf(message), type);
      return ok;
    };
  }

  // ================= Caps filtresi =================
  FILTERS.caps = { label: 'Caps', get: () => D.capsEnabled, set: (v) => { D.capsEnabled = v; save(); } };
  FILTER_ALIASES.caps = 'caps';
  FILTER_ALIASES['büyük'] = 'caps';
  FILTER_ALIASES.buyuk = 'caps';

  const CAPS_LINES = [
    'BAĞIRMA BANA!', 'kulağım yırtıldı, sakin ol!', 'bağırmana gerek yok, buradayım~',
    'hişşt, caps lock\'u kapat bakalım', 'ses seviyeni biraz kıs lütfen 🥺', 'yaaa neden bağırıyorsun, korktum',
    'küçük harfle de seni duyabiliyorum!', 'caps lock tuşu mu takıldı sana?', 'sakin ol şampiyon, kimse kaçmıyor',
    'bu ne ses yaaa 😭', 'tamam tamam duydum, bağırma!', 'kulaklarım var, bağırmana gerek yok 🙉',
  ];
  function wobble(text) {
    const vowels = 'aeıioöuüAEIİOÖUÜ';
    let chars = [...text];
    if (Math.random() < 0.6) {
      const idx = chars.map((c, i) => (vowels.includes(c) ? i : -1)).filter((i) => i >= 0);
      if (idx.length) { const i = pick(idx); chars[i] = chars[i].repeat(2 + Math.floor(Math.random() * 4)); }
    }
    if (Math.random() < 0.5) {
      chars = chars.map((c) => {
        if (Math.random() > 0.3) return c;
        const up = c.toLocaleUpperCase('tr-TR');
        return c === up ? c.toLocaleLowerCase('tr-TR') : up;
      });
    }
    let out = chars.join('');
    if (Math.random() < 0.5) out += pick(['!', '!!', '!!!', '~', '!?', '...']);
    return out;
  }
  const capsCooldown = new Map();
  async function checkCaps(message) {
    if (!D.capsEnabled) return false;
    const raw = message.content.replace(/<[^>]+>/g, ' ').replace(/https?:\/\/\S+/g, ' ').replace(/:[a-z0-9_]+:/gi, ' ');
    let up = 0, total = 0;
    for (const ch of raw) {
      const hi = ch.toLocaleUpperCase('tr-TR');
      if (ch.toLocaleLowerCase('tr-TR') === hi) continue;
      total++;
      if (ch === hi) up++;
    }
    if (total < D.caps.minLetters || up / total < D.caps.ratio) return false;

    const uid = uidOf(message);
    const deleted = await actions.deleteMessage(message);
    const last = capsCooldown.get(uid) || 0;
    if (Date.now() - last > 8000) {
      capsCooldown.set(uid, Date.now());
      await say(message, `<@${uid}> ${wobble(pick(CAPS_LINES))}`);
    }
    await actions.log(ev('📢 Caps engellendi', COLORS.warn, [['Kullanıcı', who(uid)], ['Mesaj', deleted ? 'Silindi' : 'SİLİNEMEDİ']]));
    return true;
  }

  // ================= Hoş geldin (kayıttan sonra) =================
  async function sendWelcome(gid, uid, { test = false, always = false } = {}) {
    const w = D.welcome;
    if (!w.enabled || !w.channelId) return;
    const key = `${gid}:${uid}`;
    if (!test && !always) {
      if (D.welcomed[key]) return; // aynı kişi tekrar kayıt olsa da bir kez karşılanır
      D.welcomed[key] = Date.now();
      touch();
    }
    const guildName = client.guilds?.get(gid)?.name ?? 'sunucumuz';
    const text = pick(w.messages).replaceAll('{user}', `<@${uid}>`).replaceAll('{server}', guildName);
    const gif = w.gifs.length ? pick(w.gifs) : null;
    await postToChannel(w.guildId || gid, w.channelId, {
      content: `<@${uid}>`,
      embeds: [{ description: text, color: COLORS.ok, image: gif ? { url: gif } : undefined, footer: { text: 'RINAE • Hoş geldin 💖' } }],
    });
  }
   async function onRegistered(gid, uid) {
    gd(gid).r++;
    touch();
  }

  // ================= Başvurular (yazılı) =================
  const appSessions = new Map();
  const appName = (v) => T(v || '').replace(/[^\p{L}\p{N}_-]/gu, '');
  const appKey = (gid, uid) => `${gid}:${uid}`;

  async function askNext(s) {
    const t = D.apps.types[s.type];
    if (!t) return;
    await postToChannel(s.gid, s.channelId, {
      embeds: [{
        title: `📋 ${t.title} • Soru ${s.idx + 1}/${t.questions.length}`,
        description: `<@${s.uid}> ${t.questions[s.idx]}`,
        color: COLORS.main,
        footer: { text: 'Cevabını bu kanala yaz • İptal: !basvuru-iptal' },
      }],
    });
  }
  async function finishApp(s) {
    const t = D.apps.types[s.type];
    appSessions.delete(appKey(s.gid, s.uid));
    if (!t) return;
    const sub = {
      id: D.apps.nextId++, type: s.type, gid: s.gid, userId: s.uid, channelId: s.channelId,
      answers: t.questions.map((q, i) => ({ q, a: s.answers[i] ?? '—' })),
      status: 'pending', createdAt: Date.now(),
    };
    D.apps.subs.push(sub);
    save();
    await postToChannel(t.guildId || s.gid, t.channelId || s.channelId, {
      embeds: [{
        title: `📥 Yeni başvuru #${sub.id} • ${t.title}`,
        color: COLORS.warn,
        description: `Başvuran: ${who(s.uid)}\nOnay: \`!basvuru-onay ${sub.id}\` • Red: \`!basvuru-red ${sub.id} [sebep]\``,
        fields: sub.answers.slice(0, 20).map((x, i) => ({ name: cut(`${i + 1}. ${x.q}`, 250), value: cut(x.a), inline: false })),
      }],
    });
    await postToChannel(s.gid, s.channelId, { content: `<@${s.uid}> başvurun alındı! Numaran: **#${sub.id}**. Yetkililer en kısa sürede değerlendirecek 💌` });
    await actions.log(ev('📥 Yeni başvuru', COLORS.main, [['Tür', t.title], ['Başvuran', who(s.uid)], ['No', `#${sub.id}`]]));
  }

  async function onMessage(message) {
    const gid = guildIdOf(message);
    const s = gid ? appSessions.get(appKey(gid, uidOf(message))) : null;
    if (s && message.channelId === s.channelId) {
      s.last = Date.now();
      s.answers.push(message.content.trim().slice(0, 1000));
      s.idx++;
      const t = D.apps.types[s.type];
      if (!t || s.idx >= t.questions.length) await finishApp(s); else await askNext(s);
      return true;
    }
    countMessage(message);
    return false;
  }

  // ================= Şikayetler =================
  function attachmentUrls(message) {
    const a = message.attachments;
    const out = [];
    const push = (v) => { const u = typeof v === 'string' ? v : v?.url ?? v?.proxy_url ?? v?.proxyURL; if (u) out.push(String(u)); };
    if (!a) return out;
    if (Array.isArray(a)) a.forEach(push);
    else if (typeof a.forEach === 'function') a.forEach((v) => push(v));
    else if (typeof a === 'object') Object.values(a).forEach(push);
    return out;
  }
  const STATUS_TR = { open: '🟡 Açık', solved: '✅ Çözüldü', rejected: '❌ Reddedildi' };
  function reportEmbed(r) {
    const img = r.files.find((u) => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u));
    return {
      title: `🚨 Şikayet #${r.id}`,
      color: r.status === 'open' ? COLORS.bad : r.status === 'solved' ? COLORS.ok : COLORS.warn,
      description: cut(r.text || '(açıklama yok)', 1500),
      image: img ? { url: img } : undefined,
      fields: [
        { name: 'Şikayet eden', value: who(r.reporterId), inline: true },
        { name: 'Durum', value: STATUS_TR[r.status], inline: true },
        { name: 'İlgilenen', value: r.assignee ? who(r.assignee) : 'Atanmadı', inline: true },
        r.files.length ? { name: '📎 Ekler', value: cut(r.files.join('\n')), inline: false } : null,
      ].filter(Boolean),
      timestamp: new Date(r.createdAt).toISOString(),
    };
  }
  const findReport = (gid, id) => D.reports.list.find((r) => r.gid === gid && r.id === Number(id));

  // ================= Etkinlikler =================
  function parseWhen(s) {
    s = T(s).trim();
    let m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})\s+(\d{1,2})[:.](\d{2})$/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4] - 3, +m[5]);
    m = s.match(/^(bugün|bugun|yarın|yarin)\s+(\d{1,2})[:.](\d{2})$/);
    if (m) {
      const base = new Date(Date.now() + TR + (m[1].startsWith('y') ? DAY : 0));
      return Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), +m[2] - 3, +m[3]);
    }
    return null;
  }
  const findEvent = (gid, id) => D.events.list.find((e) => e.gid === gid && e.id === Number(id));
  const EV_STATUS = { upcoming: '🟢 Yaklaşıyor', started: '🔴 Başladı', ended: '🏁 Bitti', cancelled: '⛔ İptal' };
  function eventPayload(e) {
    const people = e.participants.slice(0, 20).map((u) => `<@${u}>`).join(' ') || 'Henüz kimse yok';
    const embed = {
      title: `🎉 ${e.title} • #${e.id}`,
      color: e.status === 'cancelled' ? COLORS.bad : COLORS.main,
      description: `Buton çalışmazsa \`!event-join ${e.id}\` yaz.`,
      fields: [
        { name: '🕒 Zaman', value: fmtTime(e.startAt), inline: true },
        { name: 'Durum', value: EV_STATUS[e.status], inline: true },
        { name: '🎁 Ödül', value: e.rewardRoleId ? mentionRole(e.rewardRoleId) : 'Yok', inline: true },
        { name: `👥 Katılanlar (${e.participants.length})`, value: cut(people), inline: false },
      ],
    };
    const open = e.status === 'upcoming' || e.status === 'started';
    return {
      embeds: [embed],
      components: open ? [makeRow([
        { id: `ui:ev:join:${e.id}`, label: '✅ Katıl', style: 'Success' },
        { id: `ui:ev:leave:${e.id}`, label: '❌ Ayrıl', style: 'Danger' },
      ])] : [],
    };
  }
  function setParticipation(e, uid, join) {
    const has = e.participants.includes(uid);
    if (join && !has) e.participants.push(uid);
    if (!join && has) e.participants = e.participants.filter((u) => u !== uid);
    save();
    return join ? !has : has;
  }

  async function handleInteraction(interaction, { parts, userId, gid }) {
    // ui:ev:<join|leave>:<etkinlikID>
    const action = parts[2];
    const e = findEvent(gid, parts[3]);
    if (!e) { await respondPrivate(interaction, 'Bu etkinlik bulunamadı.'); return true; }
    if (e.status === 'ended' || e.status === 'cancelled') { await respondPrivate(interaction, 'Bu etkinlik artık aktif değil.'); return true; }
    setParticipation(e, String(userId), action === 'join');
    await respondUpdate(interaction, eventPayload(e));
    return true;
  }

  // ================= Haftanın üyesi =================
  function motwScores(gid) {
    const w = D.weights, since = Date.now() - 7 * DAY, S = {};
    const get = (u) => (S[u] ||= { m: 0, e: 0, r: 0, score: 0 });
    for (const k of lastDays(7)) {
      const d = D.stats[gid]?.daily?.[k];
      if (d) for (const [u, c] of Object.entries(d.u)) get(u).m += c;
    }
    for (const a of D.attendance) if (a.gid === gid && a.at >= since) get(a.uid).e++;
    for (const r of D.reports.list) {
      if (r.gid === gid && r.status === 'solved' && (r.solvedAt ?? r.createdAt) >= since) get(r.reporterId).r++;
    }
    for (const v of Object.values(S)) v.score = Math.min(v.m, w.msgCap) * w.msg + v.e * w.event + v.r * w.report;
    return Object.entries(S).filter(([, v]) => v.score > 0).sort((a, b) => b[1].score - a[1].score);
  }

  // ================= Raporlar =================
  function delta(cur, prev) {
    const d = cur - prev;
    return `**${cur}** (${d >= 0 ? '+' : ''}${d}, geçen hafta ${prev})`;
  }
  function buildWeekly(gid) {
    const now = Date.now();
    const cur = lastDays(7, now), prev = lastDays(7, now - 7 * DAY);
    const inRange = (t, a, b) => t >= a && t < b;
    const cs = now - 7 * DAY, ps = now - 14 * DAY;
    const ev7 = (from, to) => D.attendance.filter((a) => a.gid === gid && inRange(a.at, from, to)).length;
    const held = (from, to) => D.events.list.filter((e) => e.gid === gid && e.status === 'ended' && inRange(e.endedAt ?? 0, from, to)).length;
    const reps = (from, to) => D.reports.list.filter((r) => r.gid === gid && inRange(r.createdAt, from, to)).length;
    const top = motwScores(gid)[0];
    return emb('📈 Haftalık Gelişim Raporu', COLORS.main, [
      ['💬 Mesaj trafiği', delta(sumDays(gid, cur, 'm'), sumDays(gid, prev, 'm')), false],
      ['👋 Yeni üye', delta(sumDays(gid, cur, 'j'), sumDays(gid, prev, 'j')), false],
      ['📝 Tamamlanan kayıt', delta(sumDays(gid, cur, 'r'), sumDays(gid, prev, 'r')), false],
      ['🎉 Yapılan etkinlik', delta(held(cs, now + 1), held(ps, cs)), false],
      ['🙋 Etkinlik katılımı', delta(ev7(cs, now + 1), ev7(ps, cs)), false],
      ['🚨 Şikayet', delta(reps(cs, now + 1), reps(ps, cs)), false],
      ['🔨 Moderasyon işlemi', delta(sumDays(gid, cur, 'mod'), sumDays(gid, prev, 'mod')), false],
      ['⭐ Haftanın üyesi adayı', top ? `${who(top[0])}\n${top[1].score} puan` : 'Yeterli veri yok', false],
    ]);
  }

  // ================= Zamanlayıcı =================
  let lastDay = dayKey();
  async function tick() {
    const now = Date.now();

    for (const e of D.events.list) {
      if (e.status !== 'upcoming') continue;
      const due = D.events.reminderMins.filter((m) => now >= e.startAt - m * 60000 && now < e.startAt);
      if (due.some((m) => !e.reminded.includes(m))) {
        due.forEach((m) => { if (!e.reminded.includes(m)) e.reminded.push(m); });
        const left = Math.max(1, Math.round((e.startAt - now) / 60000));
        const pings = e.participants.slice(0, 40).map((u) => `<@${u}>`).join(' ');
        await postToChannel(e.gid, e.channelId, { content: `⏰ **${e.title}** etkinliği yaklaşık **${left} dakika** sonra başlıyor! ${pings}` });
        touch();
      }
      if (now >= e.startAt) {
        e.status = 'started';
        const pings = e.participants.slice(0, 40).map((u) => `<@${u}>`).join(' ');
        await postToChannel(e.gid, e.channelId, { content: `🎉 **${e.title}** başladı! ${pings}` });
        touch();
      }
    }

    for (const [k, s] of appSessions) {
      if (now - s.last > 15 * 60_000) {
        appSessions.delete(k);
        await postToChannel(s.gid, s.channelId, { content: `<@${s.uid}> süre dolduğu için başvurun iptal edildi. İstersen \`!basvuru ${s.type}\` ile yeniden başlayabilirsin.` });
      }
    }

    const wr = D.weeklyReport;
    if (wr.channelId && now - wr.lastSent >= 7 * DAY) {
      wr.lastSent = now;
      save();
      await postToChannel(wr.guildId, wr.channelId, { embeds: [buildWeekly(wr.guildId)] });
    }

    if (dayKey() !== lastDay) {
      lastDay = dayKey();
      const limit = dayKey(now - 90 * DAY);
      for (const g of Object.values(D.stats)) for (const k of Object.keys(g.daily)) if (k < limit) delete g.daily[k];
      D.attendance = D.attendance.filter((a) => a.at > now - 90 * DAY);
      touch();
    }
  }
  setInterval(() => tick().catch((e) => console.warn('tick:', e?.message)), 30_000).unref?.();
  setInterval(() => {
    if (!D.up.first) D.up.first = Date.now();
    D.up.total++;
    D.up.days[dayKey()] = (D.up.days[dayKey()] || 0) + 1;
    touch();
  }, 60_000).unref?.();
  if (!D.up.first) D.up.first = Date.now();

  // ================= Komutlar =================
  Object.assign(commands, {
    // ----- Komut izinleri -----
    async 'komut-izin'(message, args) {
      if (!(await needAdmin(message))) return;
      const sub = T(args[0]);
      if (!sub || sub === 'liste') {
        const rows = Object.entries(D.cmdRoles).map(([k, r]) => [`!${k}`, r.length ? r.map(mentionRole).join(' ') : 'Sadece yöneticiler', false]);
        return sendPanel(message, { embeds: [emb('🔐 Komut İzinleri', COLORS.main, rows.length ? rows : [['Durum', 'Özel izin tanımlı değil (varsayılan kurallar geçerli)', false]],
          'Kullanım:\n`!komut-izin ver <komut> <rolID>`\n`!komut-izin al <komut> <rolID>`\n`!komut-izin yonetici <komut>` (sadece yöneticiler)\n`!komut-izin sifirla <komut>`\nSunucu sahibi ve yöneticiler her komutu kullanır.')] });
      }
      const cmd = canonOf(args[1]);
      if (!cmd) return message.reply('Böyle bir komut yok. Örnek: !komut-izin ver ban 123456789');
      if (cmd === 'komut-izin') return message.reply('Kendini kilitlememek için bu komutun izni değiştirilemez.');
      if (sub === 'ver') {
        const r = cleanId(args[2]);
        if (!isId(r)) return message.reply('Kullanım: !komut-izin ver <komut> <rolID>');
        const list = (D.cmdRoles[cmd] ||= []);
        if (!list.includes(r)) list.push(r);
      } else if (sub === 'al') {
        const r = cleanId(args[2]);
        D.cmdRoles[cmd] = (D.cmdRoles[cmd] || []).filter((x) => x !== r);
        if (!D.cmdRoles[cmd].length) delete D.cmdRoles[cmd];
      } else if (sub === 'yonetici' || sub === 'yönetici') {
        D.cmdRoles[cmd] = [];
      } else if (sub === 'sifirla' || sub === 'sıfırla') {
        delete D.cmdRoles[cmd];
      } else return message.reply('Kullanım: !komut-izin <liste|ver|al|yonetici|sifirla> <komut> [rolID]');
      save();
      await actions.log(ev('🔐 Komut izni değişti', COLORS.warn, [['Komut', `!${cmd}`], ['Yetkili', who(message.author.id)]]));
      return message.reply(`!${cmd} izinleri güncellendi: ${D.cmdRoles[cmd] ? (D.cmdRoles[cmd].length ? D.cmdRoles[cmd].join(', ') : 'sadece yöneticiler') : 'varsayılan'}`);
    },

    // ----- Caps -----
    async caps(message, args) {
      if (!(await needAdmin(message))) return;
      if (T(args[0]) === 'ayar') {
        const min = Number(args[1]), pct = Number(args[2]);
        if (!(min >= 3) || !(pct >= 40 && pct <= 100)) return message.reply('Kullanım: !caps ayar <en az harf (3+)> <büyük harf yüzdesi (40-100)>');
        D.caps = { minLetters: min, ratio: pct / 100 };
        save();
      }
      return message.reply(`Caps filtresi: ${D.capsEnabled ? 'açık' : 'kapalı'} • En az ${D.caps.minLetters} harf • %${Math.round(D.caps.ratio * 100)} büyük harf\nAçıp kapatmak için: !filtre caps aç|kapat`);
    },

    // ----- Hoş geldin -----
    async hosgeldin(message, args) {
      if (!(await needAdmin(message))) return;
      const w = D.welcome, sub = T(args[0]), rest = args.slice(1).join(' ').trim();
      const usage = '`!hosgeldin kanal` • `ac|kapat` • `gif-ekle <url>` • `gif-sil <no>` • `gif-liste` • `mesaj-ekle <metin>` ({user}, {server} kullanılabilir) • `mesaj-sil <no>` • `mesaj-liste` • `test`';
      if (sub === 'kanal') { w.channelId = message.channelId; w.guildId = guildIdOf(message); }
      else if (sub === 'ac' || sub === 'aç') w.enabled = true;
      else if (sub === 'kapat') w.enabled = false;
      else if (sub === 'gif-ekle') {
        if (!/^https?:\/\/\S+$/i.test(rest)) return message.reply('Geçerli bir bağlantı yaz: !hosgeldin gif-ekle https://...');
        w.gifs.push(rest);
      } else if (sub === 'gif-sil') {
        const i = Number(rest) - 1;
        if (!w.gifs[i]) return message.reply('Bu numarada gif yok. !hosgeldin gif-liste');
        w.gifs.splice(i, 1);
      } else if (sub === 'gif-liste') {
        return message.reply(w.gifs.length ? w.gifs.map((g, i) => `${i + 1}. ${g}`).join('\n').slice(0, 1900) : 'Gif listesi boş.');
      } else if (sub === 'mesaj-ekle') {
        if (!rest) return message.reply('Kullanım: !hosgeldin mesaj-ekle <metin>');
        w.messages.push(rest.slice(0, 500));
      } else if (sub === 'mesaj-sil') {
        const i = Number(rest) - 1;
        if (!w.messages[i]) return message.reply('Bu numarada mesaj yok.');
        if (w.messages.length === 1) return message.reply('En az bir mesaj kalmalı.');
        w.messages.splice(i, 1);
      } else if (sub === 'mesaj-liste') {
        return message.reply(w.messages.map((m, i) => `${i + 1}. ${m}`).join('\n').slice(0, 1900));
      } else if (sub === 'test') {
        if (!w.channelId) return message.reply('Önce kanalı ayarla: !hosgeldin kanal');
        await sendWelcome(guildIdOf(message), uidOf(message), { test: true });
        return message.reply('Test mesajı gönderildi.');
      } else {
        return message.reply(`Hoş geldin ayarları:\n${usage}\n\nDurum: ${w.enabled ? 'açık' : 'kapalı'} • Kanal: ${w.channelId ?? 'yok'} • ${w.gifs.length} gif • ${w.messages.length} mesaj`);
      }
      save();
      return message.reply('Hoş geldin ayarı güncellendi.');
    },

    // ----- Başvurular -----
    async 'basvuru-olustur'(message, args) {
      if (!(await needAdmin(message))) return;
      const name = appName(args[0]);
      if (!name) return message.reply('Kullanım: !basvuru-olustur <ad>  (örn: partner, yetkili)');
      if (D.apps.types[name]) return message.reply('Bu başvuru zaten var.');
      D.apps.types[name] = { title: args.slice(1).join(' ') || name, guildId: guildIdOf(message), questions: [], channelId: null, roleId: null, open: true };
      save();
      return message.reply(`"${name}" başvurusu oluşturuldu. Soru eklemek için: !basvuru-soru ${name} ekle <soru>\nDeğerlendirme kanalı için o kanalda: !basvuru-ayar ${name} kanal`);
    },
    async 'basvuru-sil'(message, args) {
      if (!(await needAdmin(message))) return;
      const name = appName(args[0]);
      if (!D.apps.types[name]) return message.reply('Böyle bir başvuru yok.');
      delete D.apps.types[name];
      save();
      return message.reply('Başvuru türü silindi (geçmiş başvurular saklanır).');
    },
    async 'basvuru-soru'(message, args) {
      if (!(await needAdmin(message))) return;
      const name = appName(args[0]), sub = T(args[1]), rest = args.slice(2).join(' ').trim();
      const t = D.apps.types[name];
      if (!t) return message.reply('Kullanım: !basvuru-soru <ad> <ekle|sil|liste> ...');
      if (sub === 'ekle') {
        if (!rest) return message.reply('Soru metnini yaz.');
        if (t.questions.length >= 20) return message.reply('En fazla 20 soru olabilir.');
        t.questions.push(rest.slice(0, 500));
        save();
      } else if (sub === 'sil') {
        const i = Number(rest) - 1;
        if (!t.questions[i]) return message.reply('Bu numarada soru yok.');
        t.questions.splice(i, 1);
        save();
      } else if (sub !== 'liste') return message.reply('Kullanım: !basvuru-soru <ad> <ekle|sil|liste> ...');
      return message.reply(t.questions.length ? t.questions.map((q, i) => `${i + 1}. ${q}`).join('\n').slice(0, 1900) : 'Henüz soru yok.');
    },
    async 'basvuru-ayar'(message, args) {
      if (!(await needAdmin(message))) return;
      const name = appName(args[0]), sub = T(args[1]);
      const t = D.apps.types[name];
      if (!t) return message.reply('Kullanım: !basvuru-ayar <ad> <kanal|rol <rolID|yok>|durum <ac|kapat>|baslik <metin>>');
      if (sub === 'kanal') { t.channelId = message.channelId; t.guildId = guildIdOf(message); }
      else if (sub === 'rol') {
        const v = T(args[2]);
        if (['yok', 'sil', '-'].includes(v)) t.roleId = null;
        else if (isId(cleanId(args[2]))) t.roleId = cleanId(args[2]);
        else return message.reply('Kullanım: !basvuru-ayar <ad> rol <rolID|yok>');
      } else if (sub === 'durum') t.open = ['ac', 'aç', 'acik', 'açık'].includes(T(args[2]));
      else if (sub === 'baslik' || sub === 'başlık') t.title = args.slice(2).join(' ').slice(0, 60) || t.title;
      else return message.reply('Kullanım: !basvuru-ayar <ad> <kanal|rol|durum|baslik> ...');
      save();
      return message.reply(`Ayarlandı. Durum: ${t.open ? 'açık' : 'kapalı'} • Değerlendirme kanalı: ${t.channelId ?? 'yok'} • Onay rolü: ${t.roleId ?? 'yok'}`);
    },
    async 'basvuru-panel'(message) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const open = Object.entries(D.apps.types).filter(([, t]) => t.guildId === gid && t.open);
      return sendPanel(message, { embeds: [emb('📋 Başvurular', COLORS.main, open.map(([n, t]) => [`${t.title}`, `Başlamak için: \`!basvuru ${n}\`\n${t.questions.length} soru`, false]),
        'Başvuru yapmak için aşağıdaki komutu bu kanala yaz. Bot soruları tek tek soracak, cevaplarını yazman yeterli.')] });
    },
    async basvuru(message, args) {
      const gid = guildIdOf(message), uid = uidOf(message);
      const name = appName(args[0]);
      if (!name) {
        const open = Object.entries(D.apps.types).filter(([, t]) => t.guildId === gid && t.open);
        return message.reply(open.length ? `Açık başvurular: ${open.map(([n]) => n).join(', ')}\nBaşlamak için: !basvuru <ad>` : 'Şu an açık başvuru yok.');
      }
      const t = D.apps.types[name];
      if (!t || t.guildId !== gid) return message.reply('Böyle bir başvuru yok.');
      if (!t.open) return message.reply('Bu başvuru şu an kapalı.');
      if (!t.questions.length) return message.reply('Bu başvurunun soruları henüz hazırlanmamış.');
      if (appSessions.has(appKey(gid, uid))) return message.reply('Zaten devam eden bir başvurun var. İptal için: !basvuru-iptal');
      if (D.apps.subs.some((s) => s.gid === gid && s.userId === uid && s.type === name && s.status === 'pending')) {
        return message.reply('Bu türde değerlendirilmeyi bekleyen bir başvurun zaten var.');
      }
      const s = { type: name, gid, uid, idx: 0, answers: [], channelId: message.channelId, last: Date.now() };
      appSessions.set(appKey(gid, uid), s);
      await message.reply(`**${t.title}** başvurusu başlıyor! Soruları cevaplamak için bu kanala yazman yeterli. (15 dk işlem yapmazsan iptal olur)`);
      return askNext(s);
    },
    async 'basvuru-iptal'(message) {
      const k = appKey(guildIdOf(message), uidOf(message));
      if (!appSessions.has(k)) return message.reply('Devam eden başvurun yok.');
      appSessions.delete(k);
      return message.reply('Başvurun iptal edildi.');
    },
    async 'basvuru-liste'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const all = T(args[0]) === 'hepsi';
      const list = D.apps.subs.filter((s) => s.gid === gid && (all || s.status === 'pending')).slice(-15).reverse();
      if (!list.length) return message.reply('Gösterilecek başvuru yok.');
      return sendPanel(message, { embeds: [emb('📋 Başvurular', COLORS.main, list.map((s) => [`#${s.id} • ${s.type}`, `${who(s.userId)}\n${s.status}`, true]))] });
    },
    async 'basvuru-goster'(message, args) {
      if (!(await needAdmin(message))) return;
      const s = D.apps.subs.find((x) => x.gid === guildIdOf(message) && x.id === Number(args[0]));
      if (!s) return message.reply('Başvuru bulunamadı.');
      return sendPanel(message, { embeds: [emb(`📋 Başvuru #${s.id} • ${s.type}`, COLORS.main,
        [['Başvuran', who(s.userId)], ['Durum', s.status], ...s.answers.map((x, i) => [cut(`${i + 1}. ${x.q}`, 250), x.a, false])].slice(0, 25))] });
    },
    async 'basvuru-onay'(message, args) {
      if (!(await needAdmin(message))) return;
      return decideApp(message, args, true);
    },
    async 'basvuru-red'(message, args) {
      if (!(await needAdmin(message))) return;
      return decideApp(message, args, false);
    },

    // ----- Şikayetler -----
    async sikayet(message, args) {
      const gid = guildIdOf(message);
      const text = args.join(' ').trim();
      const files = attachmentUrls(message);
      if (!text && !files.length) return message.reply('Kullanım: !sikayet <açıklama>  (ekran görüntüsünü aynı mesaja ekleyebilirsin)');
      if (!D.reports.channelId) return message.reply('Şikayet kanalı henüz ayarlanmamış. Bir yetkiliye haber ver.');
      const r = { id: D.reports.nextId++, gid, reporterId: uidOf(message), text, files, status: 'open', assignee: null, createdAt: Date.now() };
      D.reports.list.push(r);
      gd(gid).rep++;
      save();
      await postToChannel(D.reports.guildId || gid, D.reports.channelId, {
        content: D.reports.pingRoleId ? `${mentionRole(D.reports.pingRoleId)} yeni şikayet!` : undefined,
        embeds: [reportEmbed(r)],
      });
      return message.reply(`Şikayetin yetkililere iletildi. Numara: #${r.id} 💌 (Ekran görüntüsünün silinmemesi için kendi mesajını silme.)`);
    },
    async 'sikayet-ayar'(message, args) {
      if (!(await needAdmin(message))) return;
      const sub = T(args[0]);
      if (sub === 'kanal') { D.reports.channelId = message.channelId; D.reports.guildId = guildIdOf(message); }
      else if (sub === 'rol') {
        if (['yok', 'sil', '-'].includes(T(args[1]))) D.reports.pingRoleId = null;
        else if (isId(cleanId(args[1]))) D.reports.pingRoleId = cleanId(args[1]);
        else return message.reply('Kullanım: !sikayet-ayar rol <rolID|yok>');
      } else return message.reply(`Kullanım: !sikayet-ayar kanal | !sikayet-ayar rol <rolID|yok>\nŞu an: kanal ${D.reports.channelId ?? 'yok'}, bildirim rolü ${D.reports.pingRoleId ?? 'yok'}`);
      save();
      return message.reply('Şikayet ayarı güncellendi.');
    },
    async 'sikayet-liste'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const list = D.reports.list.filter((r) => r.gid === gid && (T(args[0]) === 'hepsi' || r.status === 'open')).slice(-15).reverse();
      if (!list.length) return message.reply('Gösterilecek şikayet yok.');
      return sendPanel(message, { embeds: [emb('🚨 Şikayetler', COLORS.bad, list.map((r) => [`#${r.id} • ${STATUS_TR[r.status]}`, `${who(r.reporterId)}\n${cut(r.text, 80)}`]))] });
    },
    async 'sikayet-goster'(message, args) {
      if (!(await needAdmin(message))) return;
      const r = findReport(guildIdOf(message), args[0]);
      if (!r) return message.reply('Şikayet bulunamadı.');
      return sendPanel(message, { embeds: [reportEmbed(r)] });
    },
    async 'sikayet-ata'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const r = findReport(gid, args[0]);
      const target = resolveUserIds(message, args[1])[0];
      if (!r || !target) return message.reply('Kullanım: !sikayet-ata <no> <kullanıcı>');
      r.assignee = target;
      save();
      await postToChannel(D.reports.guildId || gid, D.reports.channelId, { content: `<@${target}> sana #${r.id} numaralı şikayet atandı.`, embeds: [reportEmbed(r)] });
      return message.reply('Şikayet atandı.');
    },
    async 'sikayet-coz'(message, args) {
      if (!(await needAdmin(message))) return;
      return closeReport(message, args, 'solved');
    },
    async 'sikayet-ret'(message, args) {
      if (!(await needAdmin(message))) return;
      return closeReport(message, args, 'rejected');
    },

    // ----- Etkinlikler -----
    async 'event-create'(message, args) {
      if (!(await needAdmin(message))) return;
      const [title, when, reward] = args.join(' ').split('|').map((s) => s.trim());
      const startAt = when ? parseWhen(when) : null;
      if (!title || !startAt) return message.reply('Kullanım: !event-create <başlık> | <GG.AA.YYYY SS:DD veya yarın 21:00> | [ödül rolID]');
      if (startAt < Date.now()) return message.reply('Bu zaman geçmişte kalmış.');
      const gid = guildIdOf(message);
      const e = {
        id: D.events.nextId++, gid, title: title.slice(0, 80), startAt, status: 'upcoming', participants: [], reminded: [],
        channelId: D.events.channelId || message.channelId, rewardRoleId: reward && isId(cleanId(reward)) ? cleanId(reward) : null,
        createdBy: uidOf(message),
      };
      D.events.list.push(e);
      save();
      const ok = await postToChannel(D.events.guildId || gid, e.channelId, eventPayload(e));
      await actions.log(ev('🎉 Etkinlik oluşturuldu', COLORS.ok, [['Etkinlik', `#${e.id} ${e.title}`], ['Zaman', fmtTime(startAt)], ['Yetkili', who(uidOf(message))]]));
      return ok ? undefined : message.reply('Etkinlik kaydedildi ama mesaj gönderilemedi.');
    },
    async 'event-kanal'(message) {
      if (!(await needAdmin(message))) return;
      D.events.channelId = message.channelId;
      D.events.guildId = guildIdOf(message);
      save();
      return message.reply('Etkinlikler artık bu kanalda duyurulacak.');
    },
    async 'event-list'(message) {
      const gid = guildIdOf(message);
      const list = D.events.list.filter((e) => e.gid === gid && (e.status === 'upcoming' || e.status === 'started'));
      if (!list.length) return message.reply('Yaklaşan etkinlik yok.');
      return sendPanel(message, { embeds: [emb('🎉 Etkinlik Takvimi', COLORS.main, list.map((e) => [`#${e.id} • ${e.title}`, `${fmtTime(e.startAt)}\n${EV_STATUS[e.status]} • ${e.participants.length} katılımcı\n\`!event-join ${e.id}\``, false]))] });
    },
    async 'event-info'(message, args) {
      const e = findEvent(guildIdOf(message), args[0]);
      if (!e) return message.reply('Etkinlik bulunamadı.');
      return sendPanel(message, { embeds: eventPayload(e).embeds });
    },
    async 'event-join'(message, args) {
      const e = findEvent(guildIdOf(message), args[0]);
      if (!e || e.status === 'ended' || e.status === 'cancelled') return message.reply('Katılabileceğin böyle bir etkinlik yok.');
      return message.reply(setParticipation(e, uidOf(message), true) ? `**${e.title}** etkinliğine katıldın! 🎉` : 'Zaten katılmışsın.');
    },
    async 'event-leave'(message, args) {
      const e = findEvent(guildIdOf(message), args[0]);
      if (!e || e.status === 'ended' || e.status === 'cancelled') return message.reply('Böyle bir etkinlik yok.');
      return message.reply(setParticipation(e, uidOf(message), false) ? 'Etkinlikten ayrıldın.' : 'Zaten katılmamışsın.');
    },
    async 'event-cancel'(message, args) {
      if (!(await needAdmin(message))) return;
      const e = findEvent(guildIdOf(message), args[0]);
      if (!e || e.status === 'ended') return message.reply('İptal edilebilir etkinlik bulunamadı.');
      e.status = 'cancelled';
      save();
      return say(message, `⛔ **${e.title}** etkinliği iptal edildi. ${e.participants.slice(0, 40).map((u) => `<@${u}>`).join(' ')}`);
    },
    async 'event-end'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const e = findEvent(gid, args[0]);
      if (!e || e.status === 'ended' || e.status === 'cancelled') return message.reply('Bitirilebilir etkinlik bulunamadı.');
      e.status = 'ended';
      e.endedAt = Date.now();
      let given = 0, failed = 0;
      for (const u of e.participants) {
        D.attendance.push({ gid, uid: u, eventId: e.id, at: Date.now() });
        if (e.rewardRoleId) { if (await roleOp('PUT', gid, u, e.rewardRoleId)) given++; else failed++; }
      }
      save();
      await actions.log(ev('🏁 Etkinlik bitti', COLORS.ok, [['Etkinlik', `#${e.id} ${e.title}`], ['Katılımcı', e.participants.length], e.rewardRoleId ? ['Ödül', `${given} verildi, ${failed} verilemedi`] : null]));
      return say(message, `🏁 **${e.title}** sona erdi! ${e.participants.length} kişi katıldı, teşekkürler 💖` + (e.rewardRoleId ? `\n🎁 Ödül rolü ${given} kişiye verildi.` + (failed ? ` (${failed} kişiye verilemedi, botun rolünü kontrol et)` : '') : ''));
    },

    // ----- İstatistikler -----
    async 'server-stats'(message) {
      const gid = guildIdOf(message);
      const guild = client.guilds?.get(gid);
      const members = guild?.memberCount ?? guild?.member_count ?? guild?.members?.size;
      const w = lastDays(7);
      const registered = Object.values(getRegRecords()).filter((r) => r.guildId === gid).length;
      const openReports = D.reports.list.filter((r) => r.gid === gid && r.status === 'open').length;
      const upcoming = D.events.list.filter((e) => e.gid === gid && (e.status === 'upcoming' || e.status === 'started')).length;
      return sendPanel(message, { embeds: [emb(`📊 ${guild?.name ?? 'Sunucu'} İstatistikleri`, COLORS.main, [
        ['👥 Üye sayısı', members ?? 'Bilinmiyor'],
        ['📝 Kayıtlı üye', registered],
        ['💬 Bugünkü mesaj', gd(gid).m],
        ['💬 7 günlük mesaj', sumDays(gid, w, 'm')],
        ['👋 7 günlük yeni üye', sumDays(gid, w, 'j')],
        ['🎉 Yaklaşan etkinlik', upcoming],
        ['🚨 Açık şikayet', openReports],
        ['📋 Bekleyen başvuru', D.apps.subs.filter((s) => s.gid === gid && s.status === 'pending').length],
      ])] });
    },
    async activity(message) {
      const gid = guildIdOf(message);
      const days = lastDays(7);
      const vals = days.map((k) => D.stats[gid]?.daily?.[k]?.m || 0);
      const max = Math.max(...vals, 1);
      const chart = days.map((k, i) => `\`${k.slice(5)}\` ${bar(vals[i], max)} ${vals[i]}`).join('\n');
      const users = {}, hours = Array(24).fill(0);
      for (const k of days) {
        const d = D.stats[gid]?.daily?.[k];
        if (!d) continue;
        for (const [u, c] of Object.entries(d.u)) users[u] = (users[u] || 0) + c;
        d.h.forEach((c, h) => { hours[h] += c; });
      }
      const top = Object.entries(users).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, c], i) => `${i + 1}. <@${u}> • ${c} mesaj`).join('\n') || 'Veri yok';
      const busy = hours.map((c, h) => [h, c]).sort((a, b) => b[1] - a[1]).slice(0, 3).filter((x) => x[1] > 0).map(([h]) => `${String(h).padStart(2, '0')}:00`).join(', ') || 'Veri yok';
      return sendPanel(message, { embeds: [emb('📈 Son 7 Gün Aktivite', COLORS.main, [
        ['💬 Günlük mesajlar', chart, false], ['🏆 En aktif üyeler', top, false], ['🕒 En yoğun saatler', busy, false],
      ])] });
    },
    async 'weekly-report'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      if (T(args[0]) === 'kanal') {
        D.weeklyReport = { channelId: message.channelId, guildId: gid, lastSent: Date.now() };
        save();
        return message.reply('Haftalık rapor her 7 günde bir bu kanala otomatik gönderilecek.');
      }
      if (T(args[0]) === 'kapat') {
        D.weeklyReport.channelId = null;
        save();
        return message.reply('Otomatik haftalık rapor kapatıldı.');
      }
      return sendPanel(message, { embeds: [buildWeekly(gid)] });
    },
    async 'bot-stats'(message) {
      const owner = process.env.BOT_OWNER_ID;
      if (!owner) return message.reply('BOT_OWNER_ID tanımlı değil. PowerShell: $env:BOT_OWNER_ID="senin_id"');
      if (uidOf(message) !== String(owner)) return message.reply('Bu komut sadece bot sahibi içindir.');
      const elapsedMin = Math.max(1, (Date.now() - D.up.first) / 60000);
      const ratio = Math.min(100, (D.up.total / elapsedMin) * 100);
      const dayRatio = Math.min(100, ((D.up.days[dayKey()] || 0) / Math.max(1, (Date.now() + TR) % DAY / 60000)) * 100);
      const c = D.cmds;
      const ping = client.ws?.ping ?? client.ping;
      return sendPanel(message, { embeds: [emb('🤖 Bot İstatistikleri', COLORS.main, [
        ['🌐 Sunucu sayısı', client.guilds?.size ?? '?'],
        ['⏱️ Açık kalma süresi', fmtDur(Date.now() - startedAt)],
        ['📶 Çalışma oranı', `Genel: %${ratio.toFixed(1)}\nBugün: %${dayRatio.toFixed(1)}`],
        ['⌨️ Komut', `${c.total} çalıştı\n%${c.total ? ((1 - c.err / c.total) * 100).toFixed(1) : '100'} başarılı`],
        ['💬 İşlenen mesaj', `${messagesSeen} (bu oturum)`],
        ['🧠 Bellek', `${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`],
        ['🏓 Gecikme', typeof ping === 'number' ? `${Math.round(ping)} ms` : 'Bilinmiyor'],
        ['🔝 En çok kullanılan', Object.entries(c.byName).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `!${k}: ${v}`).join('\n') || '—', false],
      ])] });
    },

    // ----- Yetkili performansı -----
    async 'yetkili-performans'(message, args) {
      const gid = guildIdOf(message);
      let target = uidOf(message);
      if (args[0]) {
        if (!(await needAdmin(message))) return;
        const ids = resolveUserIds(message, args[0]);
        target = ids.find((i) => D.staff[`${gid}:${i}`]) ?? ids[0];
      }
      const r = D.staff[`${gid}:${target}`];
      if (!r) return message.reply('Bu kişi için henüz kayıtlı yetkili işlemi yok.');
      const total = r.ban + r.kick + r.mute + r.unmute + r.unban + r.report + r.app + r.role;
      const days = Math.max(1, (Date.now() - r.since) / DAY);
      return sendPanel(message, { embeds: [emb('🛡️ Yetkili Performansı', COLORS.main, [
        ['Yetkili', who(target)], ['📅 Takip başlangıcı', `${fmtTime(r.since)}\n(${Math.floor(days)} gün)`], ['📊 Toplam / günlük', `${total} / ${(total / days).toFixed(2)}`],
        ['🔨 Ban', r.ban], ['👢 Kick', r.kick], ['🔇 Mute/Timeout', r.mute], ['🔊 Susturma kaldırma', r.unmute], ['♻️ Unban', r.unban],
        ['🚨 Çözülen şikayet', r.report], ['📋 Değerlendirilen başvuru', r.app], ['🎭 Rol işlemi', r.role],
      ])] });
    },
    async 'yetkili-liste'(message) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      const rows = Object.entries(D.staff).filter(([k]) => k.startsWith(`${gid}:`)).map(([k, r]) => [k.slice(gid.length + 1), r, r.ban + r.kick + r.mute + r.unmute + r.unban + r.report + r.app + r.role])
        .sort((a, b) => b[2] - a[2]).slice(0, 10);
      if (!rows.length) return message.reply('Henüz kayıtlı yetkili işlemi yok.');
      return sendPanel(message, { embeds: [emb('🏆 Yetkili Sıralaması', COLORS.main, [['Sıralama', rows.map(([u, r, t], i) => `${i + 1}. <@${u}> • ${t} işlem (🔨${r.ban} 🔇${r.mute} 🚨${r.report})`).join('\n'), false]])] });
    },
    async 'yetkili-ekle'(message, args) {
      if (!(await needAdmin(message))) return;
      const id = resolveUserIds(message, args[0])[0];
      if (!id) return message.reply('Kullanım: !yetkili-ekle <kullanıcı>  (takip başlangıcını bugüne çeker ve sayaçları sıfırlar)');
      delete D.staff[`${guildIdOf(message)}:${id}`];
      staffRec(guildIdOf(message), id);
      save();
      return message.reply('Yetkili takibi bugünden itibaren başlatıldı.');
    },

    // ----- Haftanın üyesi -----
    async 'haftanin-uyesi'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message), sub = T(args[0]), m = D.motw;
      if (sub === 'kanal') { m.channelId = message.channelId; m.guildId = gid; save(); return message.reply('Duyuru kanalı ayarlandı.'); }
      if (sub === 'rol') {
        m.roleId = ['yok', '-'].includes(T(args[1])) ? null : (isId(cleanId(args[1])) ? cleanId(args[1]) : m.roleId);
        save();
        return message.reply(`Haftanın üyesi rolü: ${m.roleId ?? 'yok'}`);
      }
      if (sub === 'agirlik' || sub === 'ağırlık') {
        const map = { mesaj: 'msg', etkinlik: 'event', rapor: 'report', limit: 'msgCap' };
        const key = map[T(args[1])], val = Number(args[2]);
        if (!key || !(val >= 0)) return message.reply('Kullanım: !haftanin-uyesi agirlik <mesaj|etkinlik|rapor|limit> <sayı>');
        D.weights[key] = val;
        save();
        return message.reply(`Ağırlıklar: ${JSON.stringify(D.weights)}`);
      }
      const scores = motwScores(gid);
      if (sub === 'onayla') {
        const chosen = args[1] ? resolveUserIds(message, args[1])[0] : scores[0]?.[0];
        if (!chosen) return message.reply('Aday bulunamadı. Kullanım: !haftanin-uyesi onayla [kullanıcı]');
        if (m.roleId) {
          if (m.lastUserId && m.lastUserId !== chosen) await roleOp('DELETE', gid, m.lastUserId, m.roleId);
          await roleOp('PUT', gid, chosen, m.roleId);
        }
        m.lastUserId = chosen;
        m.history.push({ gid, uid: chosen, at: Date.now(), score: scores.find(([u]) => u === chosen)?.[1].score ?? 0 });
        save();
        await actions.log(ev('⭐ Haftanın üyesi seçildi', COLORS.ok, [['Kullanıcı', who(chosen)], ['Onaylayan', who(uidOf(message))]]));
        return postToChannel(m.guildId || gid, m.channelId || message.channelId, {
          content: `<@${chosen}>`,
          embeds: [{ title: '⭐ Haftanın Üyesi!', description: `Bu haftanın üyesi <@${chosen}> oldu! Sohbetlere, etkinliklere ve topluluğa katkıların için teşekkürler 💖`, color: COLORS.ok }],
        });
      }
      if (!scores.length) return message.reply('Bu hafta için yeterli veri yok.');
      const w = D.weights;
      return sendPanel(message, { embeds: [emb('⭐ Haftanın Üyesi Adayları', COLORS.main, [[
        `Puan = mesaj×${w.msg} (en fazla ${w.msgCap}) + etkinlik×${w.event} + çözülen şikayet×${w.report}`,
        scores.slice(0, 5).map(([u, v], i) => `${i + 1}. <@${u}> • **${v.score}** puan (💬${v.m} 🎉${v.e} 🚨${v.r})`).join('\n'), false,
      ]], 'Onaylamak için: `!haftanin-uyesi onayla [kullanıcı]`')] });
    },
  });

  async function decideApp(message, args, approve) {
    const gid = guildIdOf(message);
    const s = D.apps.subs.find((x) => x.gid === gid && x.id === Number(args[0]));
    if (!s) return message.reply('Başvuru bulunamadı. Kullanım: !basvuru-onay <no> [not]');
    if (s.status !== 'pending') return message.reply('Bu başvuru zaten sonuçlandırılmış.');
    s.status = approve ? 'approved' : 'rejected';
    s.handledBy = uidOf(message);
    s.note = args.slice(1).join(' ');
    const t = D.apps.types[s.type];
    let roleOk = true;
    if (approve && t?.roleId) roleOk = await roleOp('PUT', gid, s.userId, t.roleId);
    trackStaff(gid, uidOf(message), 'app');
    save();
    await actions.log(ev(approve ? '✅ Başvuru onaylandı' : '❌ Başvuru reddedildi', approve ? COLORS.ok : COLORS.bad, [
      ['Başvuru', `#${s.id} (${s.type})`], ['Başvuran', who(s.userId)], ['Yetkili', who(uidOf(message))], s.note ? ['Not', s.note, false] : null,
    ]));
    await postToChannel(gid, s.channelId, { content: `<@${s.userId}> #${s.id} numaralı başvurun ${approve ? '**onaylandı** 🎉' : '**reddedildi**'}.${s.note ? `\nNot: ${s.note}` : ''}` });
    return message.reply(`Başvuru #${s.id} ${approve ? 'onaylandı' : 'reddedildi'}.` + (approve && t?.roleId && !roleOk ? ' ⚠️ Rol verilemedi.' : ''));
  }
  async function closeReport(message, args, status) {
    const gid = guildIdOf(message);
    const r = findReport(gid, args[0]);
    if (!r) return message.reply('Şikayet bulunamadı. Kullanım: !sikayet-coz <no> [not]');
    if (r.status !== 'open') return message.reply('Bu şikayet zaten sonuçlandırılmış.');
    r.status = status;
    r.solvedBy = uidOf(message);
    r.solvedAt = Date.now();
    r.note = args.slice(1).join(' ');
    if (status === 'solved') trackStaff(gid, uidOf(message), 'report');
    save();
    await postToChannel(gid, D.reports.channelId || message.channelId, { content: `<@${r.reporterId}> #${r.id} numaralı şikayetin ${status === 'solved' ? '**çözüldü** ✅' : 'incelendi ve **reddedildi**'}.${r.note ? `\nNot: ${r.note}` : ''}` });
    return message.reply('Şikayet kapatıldı.');
  }

  // ================= Yardım sayfaları =================
  HELP_PAGES.community = () => ({
    title: '🎪 Topluluk Komutları',
    color: COLORS.ok,
    fields: [
      { name: '📢 Caps', value: '`!caps` / `!caps ayar <min harf> <yüzde>`\nAçma/kapama: `!filtre caps aç|kapat`', inline: false },
      { name: '💖 Hoş geldin', value: '`!hosgeldin` ayarlar, gif ve mesajları yönetir (kanal, gif-ekle, mesaj-ekle, test).', inline: false },
      { name: '📋 Başvuru', value: 'Kullanıcı: `!basvuru <ad>`, `!basvuru-iptal`\nYetkili: `!basvuru-olustur`, `!basvuru-soru`, `!basvuru-ayar`, `!basvuru-panel`, `!basvuru-liste`, `!basvuru-goster`, `!basvuru-onay`, `!basvuru-red`', inline: false },
      { name: '🚨 Şikayet', value: 'Kullanıcı: `!sikayet <açıklama>` (+ ekran görüntüsü)\nYetkili: `!sikayet-ayar`, `-liste`, `-goster`, `-ata`, `-coz`, `-ret`', inline: false },
      { name: '🎉 Etkinlik', value: '`!event-create <başlık> | <tarih> | [ödül rolID]`, `!event-list`, `!event-info`, `!event-join`, `!event-leave`, `!event-end`, `!event-cancel`, `!event-kanal`', inline: false },
    ],
  });
  HELP_PAGES.stats = () => ({
    title: '📊 İstatistik & Yönetim',
    color: COLORS.main,
    fields: [
      { name: '📊 İstatistik', value: '`!server-stats` • `!activity` • `!weekly-report` (`kanal` ile otomatik gönderim)\n`!bot-stats` (sadece bot sahibi)', inline: false },
      { name: '🛡️ Yetkili performansı', value: '`!yetkili-performans [kullanıcı]` • `!yetkili-liste` • `!yetkili-ekle <kullanıcı>`', inline: false },
      { name: '⭐ Haftanın üyesi', value: '`!haftanin-uyesi` • `onayla [kullanıcı]` • `kanal` • `rol` • `agirlik`', inline: false },
      { name: '🔐 Komut izinleri', value: '`!komut-izin liste|ver|al|yonetici|sifirla <komut> [rolID]`', inline: false },
    ],
  });

  return { onMessage, checkCaps, exempt, canRun, cmdDone, isAdmin, isAdminId: (gid, uid) => isAdminCore(gid, String(uid), null), handleInteraction, onRegistered, onJoin, flush };
}


// Ek özellikler: yönetici yetkisi, komut izinleri, caps filtresi, başvuru, şikayet, etkinlik,
// hoş geldin (kayıt sonrası), istatistikler, yetkili performansı, haftanın üyesi, haftalık rapor
ek = initEk({
  client, core, CONFIG, FILTERS, FILTER_ALIASES, HELP_PAGES, commands, actions,
  postToChannel, say, makeRow, sendPanel, requirePerm, ev, who, COLORS, cleanId,
  resolveUserIds, trLower, guildIdOf, isOwnerOf, roleOp,
  getRegRecords: () => regRecords, respondUpdate, respondPrivate,
});

// ---------- Olaylar ----------
client.on('ready', () => {
  const name = client.user?.username ?? 'bot';
  const count = client.guilds?.size ?? 0;
  console.log(`Hazır: ${name} | Sunucu sayısı: ${count}`);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;
    if (!message.content) return;
    const isCmd = message.content.startsWith(CONFIG.prefix);

    // Başvuru cevapları + mesaj sayacı (istatistik)
    if (!isCmd && (await ek.onMessage(message))) return;

    // Komut mu?
    if (isCmd) {
      const [name, ...args] = message.content.slice(CONFIG.prefix.length).trim().split(/\s+/);
      const key = name?.toLowerCase();
      if (key && Object.hasOwn(commands, key)) {
        message.__cmd = key;
        if (!(await ek.canRun(message, key))) return; // !komut-izin kontrolü
        try {
          await commands[key](message, args);
          ek.cmdDone(key, true);
        } catch (err) {
          ek.cmdDone(key, false);
          throw err;
        }
        return;
      }
    }

    // Sunucu sahibi, yöneticiler ve muaf listesindekiler filtrelere takılmaz
    const exempt = await ek.exempt(message);

    // Reklam: başka sunucu davet linki
    if (CONFIG.adFilter.enabled && !exempt) {
      const codes = findInviteCodes(message.content)
        .filter((c) => !CONFIG.adFilter.allowedInviteCodes.includes(c));
      if (codes.length > 0) {
        await punishAd(message, codes);
        return;
      }
    }

    // Yasaklı ifade (küfür): uyarı -> kademeli mute -> ban
    if (CONFIG.profanity.enabled && !exempt) {
      const matched = findBannedWord(message.content);
      if (matched) {
        await punishProfanity(message, matched);
        return;
      }
    }

    // Caps (bağırarak yazma): mesaj silinir, RINAE çeşitli cümlelerle uyarır
    if (!exempt && (await ek.checkCaps(message))) return;

    // Spam
    const userId = message.author?.id;
    if (CONFIG.spam.enabled && userId && isSpam(userId)) {
      const muted = await actions.timeout(message, userId, CONFIG.spam.timeoutMs, 'Spam');
      if (!muted) await actions.deleteMessage(message);
      await actions.log(ev('⚡ Spam algılandı', COLORS.warn, [
        ['Kullanıcı', who(userId)],
        ['İşlem', muted ? `${CONFIG.spam.timeoutMs / 60000} dk mute` : 'Mesaj silindi (mute uygulanamadı)'],
      ]));
    }
  } catch (err) {
    console.error('messageCreate hatası:', err);
  }
});

// Buton tıklamaları (yardım, filtre paneli, kayıt formu ve etkinlik katılımı)
async function respondUpdate(interaction, payload) {
  if (typeof interaction.update === 'function') return interaction.update(payload);
  if (typeof interaction.reply === 'function') return interaction.reply(payload);
  throw new Error('interaction.update/reply bulunamadı');
}
// Sadece tıklayana görünen yanıt (metin ya da { embeds, components })
async function respondPrivate(interaction, content) {
  if (typeof interaction.reply !== 'function') throw new Error('interaction.reply yok');
  const body = typeof content === 'string' ? { content } : { ...content };
  return interaction.reply({ ...body, ephemeral: true, flags: core.MessageFlags?.Ephemeral ?? 64 });
}

client.on('interactionCreate', async (interaction) => {
  try {
    if (DEBUG_MODE) console.log('[interaction alanları]', Object.keys(interaction));
    const customId = interaction.customId ?? interaction.custom_id ?? interaction.data?.custom_id;
    if (typeof customId !== 'string' || !customId.startsWith('ui:')) return;

    const parts = customId.split(':');
    const kind = parts[1];
    // help/filter: ui:<tür>:<sayfa|filtre>:<sahip>   reg: ui:reg:<işlem>:<arg>:<sahip>   ev: ui:ev:<join|leave>:<etkinlikID>
    const panelOwner = kind === 'reg' ? parts[4] : parts[3];
    const userId = interaction.user?.id ?? interaction.member?.user?.id ?? interaction.userId;
    const gid = interaction.guildId ?? interaction.guild?.id;

    // Etkinlik butonları herkese açıktır (panel sahibi kontrolü yok)
    if (kind === 'ev') {
      if (!gid || !userId) return await respondPrivate(interaction, 'Bir sorun oluştu, `!event-join <no>` ile katılabilirsin.');
      await ek.handleInteraction(interaction, { parts, userId, gid });
      return;
    }

    // Paneli açan kişi dışındakiler kullanamasın
    if (panelOwner && userId && String(panelOwner) !== String(userId)) {
      return await respondPrivate(interaction, 'Bu paneli sen açmadın. Kendi paneli için komutu kendin yaz.');
    }

    if (kind === 'help') {
      return await respondUpdate(interaction, buildHelp(parts[2], userId));
    }

    if (kind === 'filter' && FILTERS[parts[2]]) {
      if (!(await ek.isAdminId(gid, userId))) {
        return await respondPrivate(interaction, 'Filtreleri sadece sunucu sahibi ve yöneticiler değiştirebilir.');
      }
      await setFilter([parts[2]], !FILTERS[parts[2]].get(), userId);
      return await respondUpdate(interaction, buildFilters(userId));
    }

    if (kind === 'reg') {
      const sub = parts[2];
      const arg = parts[3];
      if (!gid || !userId) {
        console.warn('[kayıt] sunucu veya kullanıcı ID\'si okunamadı. DEBUG_MODE=1 ile alanlara bak.');
        return await respondPrivate(interaction, 'Bir sorun oluştu, `!kayit` yazarak tekrar dene.');
      }
      const uid = String(userId);
      const s = regSession(gid, uid);

      if (sub === 'start') return await respondPrivate(interaction, buildRegistration(gid, uid));
      if (sub === 'g' && REG.genders[arg]) s.gender = arg;
      else if (sub === 'a' && REG.ages[Number(arg)]) s.age = Number(arg);
      else if (sub === 'i' && REG.interests[Number(arg)]) {
        const i = Number(arg);
        if (s.interests.has(i)) s.interests.delete(i); else s.interests.add(i);
      } else if (sub === 'reset') {
        s.gender = null; s.age = null; s.interests.clear();
      } else if (sub === 'ok') {
        const result = await completeRegistration(gid, uid);
        if (!result.ok) return await respondPrivate(interaction, result.error);
        await actions.log(ev('📝 Yeni kayıt', COLORS.ok, [
          ['Kullanıcı', who(uid)],
          ['Cinsiyet', result.record.gender],
          ['Yaş aralığı', result.record.ageRange],
          ['İlgi alanları', result.record.interests.join(', ') || '—', false],
          result.failed.length ? ['⚠️ Verilemeyen roller', result.failed.map((r) => '`' + r + '`').join(', '), false] : null,
        ]));
        // Kayıt sonrası: istatistik + kanala tatlı hoş geldin mesajı (gif'li)
        await ek.onRegistered(gid, uid);
        return await respondUpdate(interaction, {
          embeds: [{
            title: '🎉 Kayıt tamamlandı!',
            description: result.failed.length
              ? '⚠️ Bazı roller verilemedi. Yetkililere haber ver (botun rolü yeterince yüksek olmayabilir).'
              : 'Seçimlerine göre rollerin verildi. İyi eğlenceler!',
            color: result.failed.length ? COLORS.warn : COLORS.ok,
            fields: [
              { name: '👤 Cinsiyet', value: result.record.gender, inline: true },
              { name: '🎂 Yaş aralığı', value: result.record.ageRange, inline: true },
              { name: '🎭 İlgi alanları', value: result.record.interests.join(', ') || '—', inline: false },
            ],
          }],
          components: [],
        });
      }
      return await respondUpdate(interaction, buildRegistration(gid, uid));
    }
  } catch (err) {
    console.error('interactionCreate hatası:', err);
  }
});

client.on('guildBanAdd', (data) => actions.log(ev('🚫 Ban olayı', COLORS.bad, [['Detay', JSON.stringify(data), false]])));
client.on('guildBanRemove', (data) => actions.log(ev('♻️ Unban olayı', COLORS.ok, [['Detay', JSON.stringify(data), false]])));
client.on('guildCreate', (guild) => console.log(`Sunucuya eklendi: ${guild?.id}`));
client.on('guildDelete', (guild) => console.log(`Sunucudan çıkarıldı: ${guild?.id}`));
client.on('roleDelete', (data) => actions.log(ev('🗑️ Rol silindi', COLORS.warn, [['Rol ID', '`' + data?.role_id + '`']])));
client.on('inviteCreate', (data) => actions.log(ev('🔗 Davet oluşturuldu', COLORS.main, [['Kod', data?.code]])));
client.on('typingStart', (data) => {
  if (DEBUG_MODE) console.log(`${data?.userId} yazıyor: ${data?.channelId}`);
});

// Bu olay dinlenmezse kütüphane hata fırlatır ve bot çöker, o yüzden mutlaka dinleniyor.
client.on('error', (error) => {
  console.error('Client hatası:', error);
});
client.on('debug', (message) => {
  if (DEBUG_MODE) console.log('[DEBUG]', message);
});

// Yeni üye algılama: Jubbio'nun üye katılma olayının adı dokümanda yok.
// Hem 'guildMemberAdd' hem de ham paket adında MEMBER_ADD/MEMBER_JOIN geçen olaylar dinlenir.
client.on('raw', (packet) => {
  if (DEBUG_MODE) console.log(`Raw: ${packet?.t}`, packet?.d);
  if (!/MEMBER_(ADD|JOIN)/i.test(String(packet?.t ?? ''))) return;
  const d = packet.d ?? {};
  const gid = d.guild_id ?? d.guildId;
  const uid = d.user?.id ?? d.user_id ?? d.userId ?? d.id;
  if (gid && uid && !d.user?.bot) {
    handleJoin(String(gid), String(uid)).catch((err) => warn('handleJoin', err));
  }
});
client.on('guildMemberAdd', (member) => {
  const d = member?.d ?? member?.data ?? member ?? {};
  const user = d.user ?? member?.user;
  const gid = d.guildId ?? d.guild_id ?? d.guild?.id ?? member?.guildId ?? member?.guild_id ?? member?.guild?.id;
  const uid = user?.id ?? d.userId ?? d.user_id ?? d.id ?? member?.id;
  if (DEBUG_MODE) console.log('[üye giriş] alanlar:', Object.keys(member || {}), '=> gid:', gid, 'uid:', uid);
  if (gid && uid && !user?.bot && !member?.bot) {
    handleJoin(String(gid), String(uid)).catch((err) => warn('handleJoin', err));
  }
});

// ---------- Başlat / kapat ----------
loadSettings();
loadRecords();

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN tanımlı değil. PowerShell: $env:BOT_TOKEN="token"');
  process.exit(1);
}

client.login(token).catch((err) => {
  console.error('Login başarısız (4004/4010/4011/4014 kalıcı hatalardır):', err);
  process.exit(1);
});

process.on('SIGINT', () => {
  ek?.flush();
  client.destroy();
  process.exit(0);
});

