// RINAE - Aylık sıralama (mesaj + ses dakikası)
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'rinae-siralama.json');
const TR = 3 * 3600e3;
const DAY = 864e5;
const nf = (n) => Number(n).toLocaleString('tr-TR');
const monthKey = (t = Date.now()) => new Date(t + TR).toISOString().slice(0, 7);
const prevMonth = (k) => { const [y, m] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7); };
const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
const monthName = (k) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;
const MEDAL = ['🥇', '🥈', '🥉'];

function init(ctx) {
  const {
    client, commands, HELP_PAGES, requirePerm, sendPanel, guildIdOf, COLORS, trLower, ADMIN_ONLY,
    postToChannel, isSuper, isOwnerOf, DEBUG_MODE,
  } = ctx;

  // ---------- Kalıcı veri ----------
  const data = { guilds: {}, months: {} };
  try { Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf-8'))); } catch { /* ilk çalıştırma */ }
  let timer = null, dirty = false;
  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(data)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { dirty = true; console.warn('rinae-siralama.json kaydedilemedi:', e.message); }
  }
  const save = () => { dirty = true; if (!timer) { timer = setTimeout(flush, 2000); timer.unref?.(); } };

  const cfg = (gid) => (data.guilds[gid] ||= { channelId: null, wMsg: 1, wVoice: 1, minPeople: 2, announced: null });
  function rec(gid, uid, ym = monthKey()) {
    const g = (data.months[gid] ||= {});
    if (!g[ym]) {
      g[ym] = {};
      for (const old of Object.keys(g).sort().slice(0, -6)) delete g[old]; // son 6 ay kalsın
    }
    return (g[ym][uid] ||= { m: 0, v: 0 }); // m: mesaj, v: ses (ms)
  }
  const score = (c, r) => r.m * c.wMsg + Math.floor(r.v / 60000) * c.wVoice;
  const ranked = (gid, ym, type = 'genel') => {
    const c = cfg(gid);
    const key = (r) => (type === 'mesaj' ? r.m : type === 'ses' ? Math.floor(r.v / 60000) : score(c, r));
    return Object.entries(data.months[gid]?.[ym] || {}).map(([u, r]) => ({ u, r, s: key(r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  };

  // ---------- Mesaj sayacı (index.js çağırır) ----------
  const lastMsg = new Map();
  function onMessage(message) {
    const gid = guildIdOf(message), uid = message.author?.id && String(message.author.id);
    if (!gid || !uid) return;
    const k = `${gid}:${uid}`, now = Date.now();
    if (now - (lastMsg.get(k) || 0) < 5000) return;
    lastMsg.set(k, now);
    rec(gid, uid).m++;
    save();
  }

  // ---------- Ses takibi ----------
  const vs = new Map(); // "gid:uid" -> channelId
  let lastVoiceEvent = null, voiceEvents = 0;

  function setVoice(gid, uid, ch) {
    const k = `${gid}:${uid}`;
    if (ch) vs.set(k, String(ch)); else vs.delete(k);
  }
  client.on('raw', (pkt) => {
    const t = String(pkt?.t ?? '');
    if (!/VOICE/i.test(t) || /SERVER/i.test(t)) return;
    const d = pkt.d ?? {};
    const gid = d.guild_id ?? d.guildId;
    const uid = d.user_id ?? d.userId ?? d.member?.user?.id ?? d.user?.id;
    if (!gid || !uid) return;
    if (d.member?.user?.bot || d.user?.bot) return;
    voiceEvents++;
    lastVoiceEvent = t;
    const left = /LEAVE|DISCONNECT/i.test(t);
    const ch = left ? null : (d.channel_id ?? d.channelId ?? d.channel?.id ?? null);
    setVoice(String(gid), String(uid), ch);
  });

  // Açılışta zaten seslide olanlar varsa (kütüphane önbellek tutuyorsa) onları da al
  client.on('ready', () => {
    try {
      for (const [gid, guild] of client.guilds ?? []) {
        const list = guild.voiceStates ?? guild.voice_states;
        if (!list) continue;
        const each = (s) => {
          const uid = s?.userId ?? s?.user_id ?? s?.id, ch = s?.channelId ?? s?.channel_id;
          if (uid && ch && !s?.user?.bot) setVoice(String(gid), String(uid), ch);
        };
        if (Array.isArray(list)) list.forEach(each); else list.forEach?.((s) => each(s));
      }
    } catch { /* yoksay */ }
  });

  // ---------- 30 sn'de bir: ses süresi ekle + ay sonu duyurusu ----------
  let lastTick = Date.now();
  async function tick() {
    const now = Date.now();
    const el = Math.min(now - lastTick, 120_000);
    lastTick = now;

    const byCh = new Map();
    for (const [k, ch] of vs) {
      const gid = k.slice(0, k.indexOf(':'));
      const id = `${gid}:${ch}`;
      if (!byCh.has(id)) byCh.set(id, []);
      byCh.get(id).push(k);
    }
    for (const keys of byCh.values()) {
      const gid = keys[0].slice(0, keys[0].indexOf(':'));
      if (keys.length < cfg(gid).minPeople) continue;
      for (const k of keys) rec(gid, k.slice(gid.length + 1)).v += el;
    }
    if (byCh.size) save();

    // Ay değişti mi? Geçen ayın ilk 3'ünü duyur
    const cur = monthKey(), prev = prevMonth(cur);
    for (const [gid, c] of Object.entries(data.guilds)) {
      if (c.announced === cur) continue;
      c.announced = cur; save();
      const top = ranked(gid, prev).slice(0, 3);
      if (!c.channelId || !top.length) continue;
      await postToChannel(gid, c.channelId, { embeds: [{
        title: `🏆 ${monthName(prev)} ayının şampiyonları!`,
        description: top.map((x, i) => `${MEDAL[i]} <@${x.u}> • **${nf(x.s)}** puan`).join('\n') + '\n\nYeni ay başladı, sıralama sıfırlandı. Herkese bol şans! 💖',
        color: COLORS.ok,
      }] });
    }
  }
  setInterval(() => tick().catch((e) => console.warn('[siralama]', e?.message)), 30_000).unref?.();

  // ---------- Komut ----------
  const line = (i, x) => `${MEDAL[i] ?? `**${i + 1}.**`} <@${x.u}> • **${nf(x.s)}**  (💬 ${nf(x.r.m)} • 🎙️ ${nf(Math.floor(x.r.v / 60000))} dk)`;
  const daysLeft = () => {
    const d = new Date(Date.now() + TR);
    return Math.max(0, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - TR - Date.now()) / DAY));
  };

  async function siralama(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const c = cfg(gid);
    const uid = String(message.author.id);
    const sub = trLower(args[0]);

    // ----- Ayarlar -----
    if (['kanal', 'kanal-kapat', 'agirlik', 'ağırlık', 'en-az-kisi', 'sifirla', 'sıfırla'].includes(sub)) {
      if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
      if (sub === 'kanal') { c.channelId = message.channelId; c.announced = monthKey(); save(); return message.reply('Ay sonu şampiyon duyurusu bu kanala atılacak.'); }
      if (sub === 'kanal-kapat') { c.channelId = null; save(); return message.reply('Ay sonu duyurusu kapatıldı.'); }
      if (sub === 'agirlik' || sub === 'ağırlık') {
        const key = { mesaj: 'wMsg', ses: 'wVoice' }[trLower(args[1])], v = Number(args[2]);
        if (!key || !(v >= 0 && v <= 100)) return message.reply('Kullanım: !siralama agirlik <mesaj|ses> <0-100>\nŞu an: mesaj ×' + c.wMsg + ', ses dakikası ×' + c.wVoice);
        c[key] = v; save();
        return message.reply(`Puan: mesaj ×${c.wMsg} + ses dakikası ×${c.wVoice}`);
      }
      if (sub === 'en-az-kisi') {
        const v = Number(args[1]);
        if (!(v >= 1 && v <= 10)) return message.reply(`Kullanım: !siralama en-az-kisi <1-10>\nŞu an: ${c.minPeople} (ses süresi, kanalda en az bu kadar kişi varken sayılır)`);
        c.minPeople = v; save();
        return message.reply(`Ses süresi artık kanalda en az ${v} kişi varken sayılacak.`);
      }
      if (sub === 'sifirla' || sub === 'sıfırla') {
        if (!isOwnerOf(message)) return message.reply('Bu ayın sıralamasını sadece sunucu sahibi sıfırlayabilir.');
        if (trLower(args[1]) !== 'onay') return message.reply('Bu ayın TÜM verisi silinecek. Emin isen: `!siralama sifirla onay`');
        delete data.months[gid]?.[monthKey()]; save();
        return message.reply('Bu ayın sıralaması sıfırlandı.');
      }
    }

    // ----- Hata ayıklama (bot yetkilileri) -----
    if (sub === 'debug') {
      if (!isSuper(uid)) return message.reply('Bu alt komut sadece bot yetkililerine açık.');
      const inGuild = [...vs.keys()].filter((k) => k.startsWith(`${gid}:`)).length;
      return message.reply(`🎙️ Seste takip edilen: **${inGuild}** kişi\nGelen ses olayı: **${voiceEvents}** (son: ${lastVoiceEvent ?? 'hiç gelmedi'})\nBu ayki kayıt: ${Object.keys(data.months[gid]?.[monthKey()] || {}).length} kişi`);
    }

    // ----- Kendi istatistiğim -----
    if (sub === 'ben' || sub === 'me') {
      const ym = monthKey(), all = ranked(gid, ym), i = all.findIndex((x) => x.u === uid), r = data.months[gid]?.[ym]?.[uid];
      if (!r) return message.reply('Bu ay henüz kaydın yok. Yazmaya ya da seste vakit geçirmeye başla! 💬');
      return sendPanel(message, { embeds: [{
        title: `📊 ${monthName(ym)} • Senin durumun`,
        color: COLORS.main,
        fields: [
          { name: '🏅 Sıra', value: i >= 0 ? `${i + 1}. / ${all.length}` : '—', inline: true },
          { name: '⭐ Puan', value: nf(score(c, r)), inline: true },
          { name: '💬 Mesaj', value: nf(r.m), inline: true },
          { name: '🎙️ Ses', value: `${nf(Math.floor(r.v / 60000))} dk`, inline: true },
        ],
        footer: { text: `Ay bitmesine ${daysLeft()} gün kaldı` },
      }] });
    }

    // ----- Sıralama tablosu -----
    let type = 'genel', ym = monthKey();
    for (const a of args.map(trLower)) {
      if (['mesaj', 'ses', 'genel'].includes(a)) type = a;
      else if (['gecen', 'geçen', 'gecen-ay', 'geçen-ay'].includes(a)) ym = prevMonth(ym);
    }
    const all = ranked(gid, ym, type);
    if (!all.length) return message.reply(`${monthName(ym)} için henüz veri yok.`);
    const unit = type === 'mesaj' ? 'mesaj' : type === 'ses' ? 'dk' : 'puan';
    const rows = all.slice(0, 10).map((x, i) => `${MEDAL[i] ?? `**${i + 1}.**`} <@${x.u}> • **${nf(x.s)}** ${unit}` + (type === 'genel' ? `  (💬 ${nf(x.r.m)} • 🎙️ ${nf(Math.floor(x.r.v / 60000))} dk)` : ''));
    const me = all.findIndex((x) => x.u === uid);
    if (me >= 10) rows.push(`…\n**${me + 1}.** <@${uid}> • **${nf(all[me].s)}** ${unit}`);
    const title = { genel: '🏆 Genel Sıralama', mesaj: '💬 Mesaj Sıralaması', ses: '🎙️ Ses Sıralaması' }[type];
    return sendPanel(message, { embeds: [{
      title: `${title} • ${monthName(ym)}`,
      description: rows.join('\n'),
      color: COLORS.main,
      footer: { text: ym === monthKey()
        ? `Ay bitmesine ${daysLeft()} gün kaldı • Puan: mesaj ×${c.wMsg} + ses dk ×${c.wVoice} • !siralama ben | mesaj | ses | gecen`
        : 'Geçen ayın sonuçları' },
    }] });
  }

  commands.siralama = siralama;
  commands['sıralama'] = siralama;
  commands.leaderboard = siralama;
  commands.lb = siralama;

  // ---------- Yardım ----------
  const oldC = HELP_PAGES.community;
  HELP_PAGES.community = () => {
    const p = oldC ? oldC() : { title: '🎪 Topluluk Komutları', color: COLORS.ok, fields: [] };
    if (!p.fields.some((f) => f.name === '🏆 Sıralama')) p.fields.push({
      name: '🏆 Sıralama',
      value: '`!siralama [mesaj|ses|gecen]` • `!siralama ben`\nYönetici: `kanal` • `kanal-kapat` • `agirlik mesaj|ses <sayı>` • `en-az-kisi <sayı>` • `sifirla onay`',
      inline: false,
    });
    return p;
  };

  return { onMessage, flush };
}

module.exports = { init };