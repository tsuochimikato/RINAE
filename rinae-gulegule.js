// RINAE - Güle güle (ayrılış) sistemi
// index.js ile aynı klasöre koy. Ayarlar gulegule.json dosyasında sunucu başına tutulur.
//
// Panel: !gulegule (veya !gule-gule / !güle-güle) -> butonlu panel (sadece sunucu sahibi/yöneticiler)
//   Kanal, açma/kapama, gif, mesaj havuzu, kalan kişi sayısı ve test butonlarla yönetilir.
//   Gif ve mesaj eklerken butona basınca bota yazman istenir.
// Yedek komutlar: !gulegule kanal | ac | kapat | test | gif-ekle <url>
// Mesajlarda {user} kişiyi etiketler, {count} kalan kişi sayısını yazar.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'gulegule.json');
const INPUT_TTL = 2 * 60_000;
const MAX_ITEMS = 15;

const DEFAULT_MSGS = [
  '{user} aramızdan ayrıldı 🥀 Yolun açık olsun, kapımız hep açık~',
  'Hoşça kal {user} 👋 Seni burada görmek güzeldi, kendine iyi bak!',
  '{user} çekip gitti 🥺 Gittiğin yerde de güzel şeyler seni bulsun~',
  'Güle güle {user} 🌸 Bir gün tekrar görüşmek dileğiyle!',
  '{user} sessizce çıkıp gitti 🚪 Ne diyelim, yolun açık olsun 💖',
  'Eyvah, {user} ayrıldı 😢 Seni özleyeceğiz, ara sıra uğra!',
  '{user} yola koyuldu 🧳 Güzel anılar için sağ ol, kendine iyi bak 💫',
  'Bir yıldız daha kaydı... ✨ Güle güle {user}, iyi ki uğradın!',
];
const COUNT_LINES = [
  'Geriye **{count}** kişi kaldık 💭',
  'Artık **{count}** kişiyiz.',
  'Sunucuda **{count}** kişi kaldık, hepimiz buradayız 🫂',
  '**{count}** kişi olarak yolumuza devam ediyoruz 🌷',
  'Şu an **{count}** kişiyiz~',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const nf = (n) => Number(n).toLocaleString('tr-TR');
const lower = (t) => String(t ?? '').toLocaleLowerCase('tr-TR');
const plainJson = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const toRaw = (body) => JSON.parse(JSON.stringify({ ...body, components: (body.components ?? []).map(plainJson) }));

function load() {
  for (const f of [FILE, FILE + '.bak']) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (j && typeof j.guilds === 'object') return { guilds: j.guilds };
    } catch { /* sıradakini dene */ }
  }
  return { guilds: {} };
}

function init(ctx) {
  const {
    client, commands, HELP_PAGES, postToChannel, makeRow, sendPanel, respondUpdate, respondPrivate,
    requirePerm, guildIdOf, COLORS, ADMIN_ONLY, ek, plus, isOwnerOf,
  } = ctx;

  const D = load();
  const save = () => {
    try {
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(D), 'utf-8');
      if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* yoksay */ } }
      fs.renameSync(tmp, FILE);
    } catch (e) { console.warn('gulegule.json kaydedilemedi:', e.message); }
  };
  const G = (gid) => {
    const g = (D.guilds[gid] ||= { enabled: false, channelId: null, gifs: [], messages: [...DEFAULT_MSGS], showCount: true, offset: 0 });
    if (!Array.isArray(g.gifs)) g.gifs = [];
    if (!Array.isArray(g.messages) || !g.messages.length) g.messages = [...DEFAULT_MSGS];
    if (typeof g.offset !== 'number') g.offset = 0;
    return g;
  };
  const uidOf = (m) => String(m.author.id);
  const needAdmin = (m) => requirePerm(m, 'Administrator', ADMIN_ONLY);
  const isStaffId = async (gid, uid) => plus.isSuper(uid) || (await ek.isAdminId(gid, uid));

  // ---------- Mesajı hazırla ve gönder ----------
  function memberCountOf(gid, g) {
    const guild = client.guilds?.get(gid);
    const n = guild?.memberCount ?? guild?.member_count ?? guild?.members?.size;
    return n != null && Number.isFinite(Number(n)) ? Math.max(0, Number(n) + (g.offset || 0)) : null;
  }

  const lastIdx = new Map();
  function compose(gid, uid, g) {
    let i = Math.floor(Math.random() * g.messages.length);
    if (g.messages.length > 1 && i === lastIdx.get(gid)) i = (i + 1) % g.messages.length; // üst üste aynı mesaj gelmesin
    lastIdx.set(gid, i);
    const tpl = g.messages[i];
    const count = memberCountOf(gid, g);
    let text = tpl.replaceAll('{user}', `<@${uid}>`).replaceAll('{count}', count != null ? nf(count) : '—');
    if (g.showCount && count != null && !tpl.includes('{count}')) text += '\n' + pick(COUNT_LINES).replaceAll('{count}', nf(count));
    return text;
  }

  async function sendGoodbye(gid, uid, { force = false } = {}) {
    const g = G(gid);
    if (!g.channelId || (!force && !g.enabled)) return false;
    const gif = g.gifs.length ? pick(g.gifs) : null;
    return postToChannel(gid, g.channelId, {
      content: `<@${uid}>`,
      embeds: [{
        description: compose(gid, uid, g),
        color: COLORS.warn,
        image: gif ? { url: gif } : undefined,
        footer: { text: 'RINAE • Güle güle 👋' },
      }],
    });
  }

  // ---------- Ayrılış algılama ----------
  const seen = new Map();
  const recentBans = new Map();
  setInterval(() => {
    const old = Date.now() - 10 * 60_000;
    for (const [k, t] of seen) if (t < old) seen.delete(k);
    for (const [k, t] of recentBans) if (t < old) recentBans.delete(k);
  }, 10 * 60_000).unref?.();

  async function onLeave(gid, uid) {
    if (!gid || !uid || gid === 'undefined' || uid === 'undefined') return;
    if (client.user && String(uid) === String(client.user.id)) return;
    const k = `${gid}:${uid}`;
    if (Date.now() - (seen.get(k) || 0) < 15_000) return; // aynı olayın tekrarını yoksay
    seen.set(k, Date.now());
    const g = D.guilds[gid];
    if (!g?.enabled || !g.channelId) return;
    await sleep(3000); // ban olayı geliyorsa yakalamak ve üye sayısının güncellenmesi için
    if (Date.now() - (recentBans.get(String(uid)) || 0) < 20_000) return; // banlananlara güle güle yazılmaz
    await sendGoodbye(gid, uid);
  }

  client.on('raw', (packet) => {
    if (!/MEMBER_(REMOVE|LEAVE|DELETE)/i.test(String(packet?.t ?? ''))) return;
    const d = packet.d ?? {};
    const gid = d.guild_id ?? d.guildId;
    const uid = d.user?.id ?? d.user_id ?? d.userId ?? d.id;
    if (d.user?.bot) return;
    onLeave(String(gid), String(uid)).catch((e) => console.warn('[güle güle]', e?.message || e));
  });
  
    const pickIds = (x) => {
    const d = x?.d ?? x?.data ?? x ?? {};
    const user = d.user ?? x?.user;
    return {
      gid: d.guildId ?? d.guild_id ?? d.guild?.id ?? x?.guildId ?? x?.guild_id ?? x?.guild?.id,
      uid: user?.id ?? d.userId ?? d.user_id ?? x?.userId ?? x?.user_id ?? d.id ?? x?.id,
      bot: user?.bot ?? d.bot ?? x?.bot,
    };
  };
  client.on('guildMemberRemove', (member) => {
    const { gid, uid, bot } = pickIds(member);
    if (process.env.DEBUG_MODE === '1') {
      let s = ''; try { s = JSON.stringify(member, (k, v) => (typeof v === 'bigint' ? String(v) : v)).slice(0, 400); } catch { s = '(yazdırılamadı)'; }
      console.log('[güle güle] alanlar:', Object.keys(member || {}), s, '=> gid:', gid, 'uid:', uid);
    }
    if (bot || !gid || !uid) return;
    onLeave(String(gid), String(uid)).catch((e) => console.warn('[güle güle]', e?.message || e));
  });
  
  client.on('guildBanAdd', (data) => {
    const uid = data?.user?.id ?? data?.user_id ?? data?.userId ?? data?.id;
    if (uid != null) recentBans.set(String(uid), Date.now());
  });

  // =====================================================================
  // BUTONLU PANEL
  // =====================================================================
  const waits = new Map(); // "gid:uid" -> bekleyen yazılı giriş
  const idOf = (uid) => (a, arg = '') => `gg:p:${a}:${arg}:${uid}`;
  const sty = (c) => (c ? 'Success' : 'Secondary');

  const PROMPTS = {
    gif: '🖼️ Şimdi **gif bağlantısını** bu kanala yaz (https://...). Mesajda görünmesi için doğrudan görsel/gif dosya linki olmalı.',
    msg: '💬 Şimdi **yeni mesajı** bu kanala yaz (en fazla 300 karakter).\n`{user}` kişiyi etiketler, `{count}` kalan kişi sayısını yazar. `{count}` kullanmazsan sayı satırı otomatik eklenir.',
  };

  function panelMain(gid, uid, notice) {
    const g = G(gid);
    const id = idOf(uid);
    const w = waits.get(`${gid}:${uid}`);
    const rows = [
      makeRow([
        { id: id('toggle'), label: g.enabled ? '✅ Açık' : '❌ Kapalı', style: g.enabled ? 'Success' : 'Danger' },
        { id: id('here'), label: '📍 Bu Kanal', style: 'Primary' },
        { id: id('count'), label: `👥 Sayı: ${g.showCount ? 'Açık' : 'Kapalı'}`, style: sty(g.showCount) },
        { id: id('test'), label: '🧪 Test', style: 'Secondary' },
      ]),
      makeRow([
        { id: id('gifadd'), label: '🖼️ Gif Ekle', style: 'Primary' },
        { id: id('gifs'), label: `🖼️ Gifler (${g.gifs.length})`, style: 'Secondary' },
        { id: id('msgadd'), label: '💬 Mesaj Ekle', style: 'Primary' },
        { id: id('msgs'), label: `💬 Mesajlar (${g.messages.length})`, style: 'Secondary' },
      ]),
      makeRow([
        { id: id('off', -1), label: '➖ Sayı -1', style: 'Secondary' },
        { id: id('off', 1), label: '➕ Sayı +1', style: 'Secondary' },
        { id: id('off', 0), label: '0️⃣ Düzeltmeyi Sıfırla', style: 'Secondary' },
        { id: id('close'), label: '✖ Kapat', style: 'Secondary' },
      ]),
    ];
    const lines = [];
    if (notice) lines.push(notice);
    if (w) lines.push(`${PROMPTS[w.kind]}\nVazgeçmek için \`iptal\` yaz (2 dk içinde).`);
    if (!lines.length) lines.push('Kanalı **📍 Bu Kanal** ile seç (paneli güle güle mesajlarının gideceği kanalda aç), sonra **🧪 Test** ile dene.');
    return {
      embeds: [{
        title: '👋 Güle Güle Paneli',
        description: lines.join('\n\n'),
        color: COLORS.main,
        fields: [
          { name: 'Durum', value: g.enabled ? '✅ Açık' : '❌ Kapalı', inline: true },
          { name: '📍 Kanal', value: g.channelId ? `<#${g.channelId}>` : 'Seçilmedi', inline: true },
          { name: '👥 Kalan kişi sayısı', value: g.showCount ? 'Mesajda gösterilir' : 'Gösterilmez', inline: true },
          { name: '🖼️ Gif', value: g.gifs.length ? `${g.gifs.length} adet (rastgele biri seçilir)` : 'Yok', inline: true },
          { name: '💬 Mesaj havuzu', value: `${g.messages.length} adet (rastgele biri seçilir)`, inline: true },
          { name: '🔢 Sayı düzeltme', value: `${g.offset > 0 ? '+' : ''}${g.offset}\nSayı yanlış çıkarsa ➖/➕ ile düzelt`, inline: true },
        ],
        footer: { text: 'Sadece sunucu sahibi ve yöneticiler kullanabilir' },
      }],
      components: rows,
    };
  }

  function listView(gid, uid, kind, notice) {
    const g = G(gid);
    const id = idOf(uid);
    const isGif = kind === 'gif';
    const arr = isGif ? g.gifs : g.messages;
    const lines = arr.map((x, i) => `**${i + 1}.** ${String(x).replace(/\n/g, ' ').slice(0, isGif ? 70 : 100)}`);
    const rows = [];
    for (let i = 0; i < arr.length; i += 5) {
      rows.push(makeRow(arr.slice(i, i + 5).map((_, j) => ({ id: id(isGif ? 'gifdel' : 'msgdel', i + j), label: `🗑️ ${i + j + 1}`, style: 'Secondary' }))));
    }
    const last = [{ id: id(isGif ? 'gifadd' : 'msgadd'), label: '➕ Ekle', style: 'Primary' }];
    if (!isGif) last.push({ id: id('msgreset'), label: '♻️ Varsayılana Dön', style: 'Danger' });
    last.push({ id: id('home'), label: '◀ Geri', style: 'Secondary' });
    rows.push(makeRow(last));
    const w = waits.get(`${gid}:${uid}`);
    return {
      embeds: [{
        title: isGif ? '🖼️ Güle Güle Gifleri' : '💬 Güle Güle Mesajları',
        description: [notice, w ? `${PROMPTS[w.kind]}\nVazgeçmek için \`iptal\` yaz.` : null, lines.join('\n') || 'Henüz yok.'].filter(Boolean).join('\n\n').slice(0, 3800),
        color: COLORS.main,
        footer: { text: `Silmek için numaralı butona bas • En fazla ${MAX_ITEMS} adet` },
      }],
      components: rows,
    };
  }

  // Panel butonları: gg:p:<işlem>:<arg>:<sahip>
  async function handlePanel(interaction, parts) {
    const [, , action, arg, owner] = parts;
    const gid = interaction.guildId ?? interaction.guild?.id;
    const uid = String(interaction.user?.id ?? interaction.member?.user?.id ?? interaction.userId ?? '');
    const chId = interaction.channelId ?? interaction.channel?.id ?? interaction.channel_id ?? null;
    if (!gid || !uid) return respondPrivate(interaction, 'Bir sorun oluştu, `!gulegule` yazarak tekrar dene.');
    if (owner && owner !== uid) return respondPrivate(interaction, 'Bu paneli sen açmadın. Kendi paneli için `!gulegule` yaz.');
    if (!(await isStaffId(gid, uid))) return respondPrivate(interaction, 'Bu panel sadece sunucu sahibi ve yöneticiler içindir.');

    const g = G(gid);
    const upd = (p) => respondUpdate(interaction, p);
    const wk = `${gid}:${uid}`;
    if (action === 'open') { waits.delete(wk); return respondPrivate(interaction, panelMain(gid, uid)); }
    const msgId = interaction.message?.id ?? interaction.messageId ?? interaction.message_id ?? null;

    switch (action) {
      case 'home': waits.delete(wk); return upd(panelMain(gid, uid));
      case 'close': waits.delete(wk); return upd({ embeds: [{ title: '👋 Güle güle paneli kapatıldı', color: COLORS.main }], components: [] });
      case 'toggle':
        if (!g.enabled && !g.channelId) return upd(panelMain(gid, uid, '⚠️ Önce **📍 Bu Kanal** butonuyla kanalı seç.'));
        g.enabled = !g.enabled; save();
        return upd(panelMain(gid, uid, g.enabled ? 'Güle güle mesajları açıldı.' : 'Güle güle mesajları kapatıldı.'));
      case 'here':
        if (!chId) return upd(panelMain(gid, uid, '⚠️ Kanal bilgisi okunamadı. Paneli `!gulegule kanal` yazarak o kanalda ayarla.'));
        g.channelId = chId; g.enabled = true; save();
        return upd(panelMain(gid, uid, `Güle güle mesajları artık <#${chId}> kanalına gönderilecek.`));
      case 'count': g.showCount = !g.showCount; save(); return upd(panelMain(gid, uid, `Kalan kişi sayısı ${g.showCount ? 'gösterilecek' : 'gösterilmeyecek'}.`));
      case 'off': {
        g.offset = arg === '0' ? 0 : Math.max(-100, Math.min(100, g.offset + Number(arg)));
        save();
        return upd(panelMain(gid, uid, `Sayı düzeltme: ${g.offset > 0 ? '+' : ''}${g.offset}. Doğru çıktığından emin olmak için 🧪 Test'e bas.`));
      }
      case 'test': {
        if (!g.channelId) return upd(panelMain(gid, uid, '⚠️ Önce **📍 Bu Kanal** butonuyla kanalı seç.'));
        const ok = await sendGoodbye(gid, uid, { force: true });
        return upd(panelMain(gid, uid, ok ? `Test mesajı <#${g.channelId}> kanalına gönderildi.` : '⚠️ Mesaj gönderilemedi, botun o kanalda yazma yetkisini kontrol et.'));
      }
      case 'gifadd': case 'msgadd': {
        const kind = action === 'gifadd' ? 'gif' : 'msg';
        const count = kind === 'gif' ? g.gifs.length : g.messages.length;
        if (count >= MAX_ITEMS) return upd(panelMain(gid, uid, `⚠️ En fazla ${MAX_ITEMS} ${kind === 'gif' ? 'gif' : 'mesaj'} olabilir, önce birini sil.`));
        waits.set(wk, { kind, channelId: chId, until: Date.now() + INPUT_TTL, panelMsgId: msgId, panelChannelId: chId });
        return upd(panelMain(gid, uid));
      }
      case 'gifs': return upd(listView(gid, uid, 'gif'));
      case 'msgs': return upd(listView(gid, uid, 'msg'));
      case 'gifdel': {
        const i = Number(arg);
        if (g.gifs[i] === undefined) return upd(listView(gid, uid, 'gif', '⚠️ Bu gif bulunamadı.'));
        g.gifs.splice(i, 1); save();
        return upd(listView(gid, uid, 'gif', 'Gif silindi.'));
      }
      case 'msgdel': {
        const i = Number(arg);
        if (g.messages[i] === undefined) return upd(listView(gid, uid, 'msg', '⚠️ Bu mesaj bulunamadı.'));
        if (g.messages.length <= 1) return upd(listView(gid, uid, 'msg', '⚠️ En az bir mesaj kalmalı.'));
        g.messages.splice(i, 1); save();
        return upd(listView(gid, uid, 'msg', 'Mesaj silindi.'));
      }
      case 'msgreset': g.messages = [...DEFAULT_MSGS]; save(); return upd(listView(gid, uid, 'msg', 'Mesajlar varsayılana döndürüldü.'));
      default: return undefined;
    }
  }

  // Panelin istediği yazılı cevapları yakalar (index.js messageCreate başında çağrılır)
  async function onMessage(message) {
    const gid = guildIdOf(message);
    if (!gid || !message.author) return false;
    const uid = uidOf(message);
    const wk = `${gid}:${uid}`;
    const w = waits.get(wk);
    if (!w) return false;
    if (Date.now() > w.until) { waits.delete(wk); return false; }
    if (w.channelId && message.channelId !== w.channelId) return false;

    const text = String(message.content ?? '').trim();
    waits.delete(wk);
    try { if (typeof message.delete === 'function') await message.delete(); } catch { /* yoksay */ }

    const g = G(gid);
    let notice;
    if (/^(iptal|vazgec|vazgeç)$/i.test(text)) notice = 'İşlem iptal edildi.';
    else if (w.kind === 'gif') {
      if (!/^https?:\/\/\S+$/i.test(text) || text.length > 500) notice = '⚠️ Geçerli bir bağlantı yazmalısın (https://...).';
      else if (g.gifs.includes(text)) notice = '⚠️ Bu gif zaten ekli.';
      else if (g.gifs.length >= MAX_ITEMS) notice = `⚠️ En fazla ${MAX_ITEMS} gif olabilir.`;
      else { g.gifs.push(text); save(); notice = 'Gif eklendi.'; }
    } else if (w.kind === 'msg') {
      const clean = text.replace(/<@[!&]?\d+>/g, '').replace(/@/g, '@\u200b').replace(/\s+/g, ' ').trim().slice(0, 300);
      if (!clean) notice = '⚠️ Geçersiz mesaj, tekrar dene.';
      else if (g.messages.length >= MAX_ITEMS) notice = `⚠️ En fazla ${MAX_ITEMS} mesaj olabilir.`;
      else { g.messages.push(clean); save(); notice = 'Mesaj eklendi.'; }
    }

    const body = listView(gid, uid, w.kind === 'gif' ? 'gif' : 'msg', notice);
    let edited = false;
    if (w.panelMsgId && w.panelChannelId) {
      try {
        await client.rest.request('PATCH', `/bot/guilds/${gid}/channels/${w.panelChannelId}/messages/${w.panelMsgId}`, toRaw(body));
        edited = true;
      } catch { /* yeni panel gönderilecek */ }
    }
    if (!edited) await postToChannel(gid, w.channelId ?? message.channelId, body);
    return true;
  }

  // gg:p:... panel butonları
  async function handleInteraction(interaction, customId) {
    const parts = customId.split(':');
    if (parts[1] === 'p') return handlePanel(interaction, parts);
    return undefined;
  }

  // ---------- Komutlar ----------
  async function gulegule(message, args) {
    if (!(await needAdmin(message))) return;
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const uid = uidOf(message);
    const g = G(gid);
    const sub = lower(args[0]);
    if (sub === 'kanal') {
      g.channelId = message.channelId; g.enabled = true; save();
      return message.reply('Güle güle mesajları artık bu kanala gönderilecek.');
    }
    if (sub === 'ac' || sub === 'aç') {
      if (!g.channelId) return message.reply('Önce kanalı ayarla: !gulegule kanal');
      g.enabled = true; save();
      return message.reply('Güle güle mesajları açıldı.');
    }
    if (sub === 'kapat') { g.enabled = false; save(); return message.reply('Güle güle mesajları kapatıldı.'); }
    if (sub === 'test') {
      if (!g.channelId) return message.reply('Önce kanalı ayarla: !gulegule kanal');
      await sendGoodbye(gid, uid, { force: true });
      return message.reply('Test mesajı gönderildi.');
    }
    if (sub === 'gif-ekle') {
      const url = args.slice(1).join(' ').trim();
      if (!/^https?:\/\/\S+$/i.test(url)) return message.reply('Geçerli bir bağlantı yaz: !gulegule gif-ekle https://...');
      if (g.gifs.length >= MAX_ITEMS) return message.reply(`En fazla ${MAX_ITEMS} gif olabilir.`);
      if (!g.gifs.includes(url)) g.gifs.push(url);
      save();
      return message.reply('Gif eklendi.');
    }
    waits.delete(`${gid}:${uid}`);
    return sendPanel(message, panelMain(gid, uid));
  }
  commands.gulegule = gulegule;
  commands['gule-gule'] = gulegule;
  commands['güle-güle'] = gulegule;

  // ---------- Yardım: "👋 Güle Güle" sekmesi ----------
  HELP_PAGES.farewell = () => ({
    title: '👋 Güle Güle Komutları',
    color: COLORS.warn,
    fields: [
      { name: '🎛️ Panel', value: '`!gulegule` (`!gule-gule`) yazınca butonlu panel açılır (yöneticiler).\nKanal, açma/kapama, gif, mesaj havuzu, kalan kişi sayısı ve test butonlarla yönetilir.', inline: false },
      { name: '👋 Nasıl çalışır?', value: 'Biri sunucudan ayrılınca seçilen kanala kişiyi etiketleyen samimi bir mesaj, kaç kişi kaldığınız ve (eklediysen) rastgele bir gif gider. Banlananlara mesaj atılmaz.', inline: false },
      { name: '⌨️ Yedek komutlar', value: '`!gulegule kanal` • `ac` • `kapat` • `test` • `gif-ekle <url>`', inline: false },
      { name: '💬 Mesaj değişkenleri', value: '`{user}` kişiyi etiketler, `{count}` kalan kişi sayısını yazar.', inline: false },
    ],
    footer: { text: 'RINAE • Güle güle' },
  });

  return {
    handleInteraction, onMessage, flush: save,
    // Başka panellere (yönetim, panel vb.) eklenebilecek buton tanımı
    panelButton: (uid) => ({ id: `gg:p:open::${uid}`, label: '👋 Güle Güle', style: 'Secondary' }),
  };
}

module.exports = { init };
