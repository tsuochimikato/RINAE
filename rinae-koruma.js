// RINAE - Raid & Nuke koruma modülü
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'rinae-koruma.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(ctx) {
  const {
    client, commands, actions, HELP_PAGES, requirePerm, sendPanel, guildIdOf, ev, who, COLORS,
    trLower, isSuper, isOwnerOf, ADMIN_ONLY, resolveUserIds,
  } = ctx;

  // ---------- Kalıcı ayarlar ----------
  const data = { guilds: {} };
  try { Object.assign(data, JSON.parse(fs.readFileSync(FILE, 'utf-8'))); } catch { /* ilk çalıştırma */ }
  let timer = null, dirty = false;
  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(data)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { dirty = true; console.warn('rinae-koruma.json kaydedilemedi:', e.message); }
  }
  const save = () => { dirty = true; if (!timer) { timer = setTimeout(flush, 1500); timer.unref?.(); } };

  function cfg(gid) {
    const g = (data.guilds[gid] ||= {});
    g.raid = { on: true, count: 7, sec: 10, action: 'kick', lockMin: 10, ...g.raid };
    g.nuke = { on: true, count: 4, sec: 15, ...g.nuke };
    g.limit = { on: true, count: 5, sec: 60, ...g.limit };
    g.white = g.white || [];
    return g;
  }

  // ---------- Durum (bellekte) ----------
  const joins = new Map();   // gid -> [{uid,t}]
  const locks = new Map();   // gid -> kilit bitiş zamanı
  const evs = new Map();     // gid:aktör -> [{t,w}]
  const alarmed = new Map(); // gid:aktör -> son alarm zamanı
  const modHits = new Map(); // gid:yetkili -> [zaman]

  const locked = (gid) => (locks.get(gid) || 0) > Date.now();
  const lock = (gid, min) => locks.set(gid, Date.now() + min * 60_000);
  const ownerOf = (gid) => {
    const g = client.guilds?.get(gid);
    const o = g?.ownerId ?? g?.owner_id ?? g?.ownerID;
    return o ? String(o) : null;
  };
  const trusted = (gid, uid) =>
    String(uid) === String(client.user?.id) || String(uid) === ownerOf(gid) || isSuper(String(uid)) || cfg(gid).white.includes(String(uid));
  const punish = (gid, uid, action, reason) => {
    const fake = { guildId: gid };
    return action === 'ban' ? actions.ban(fake, uid, reason) : actions.kick(fake, uid, reason);
  };
  const num = (v, min, max) => { const x = Number(v); return Number.isFinite(x) && x >= min && x <= max ? x : null; };

  // ---------- Raid: yeni üye girişi (index.js handleJoin çağırır) ----------
  // true dönerse üye cezalandırıldı demektir, hoş geldin akışı atlanır
  async function onJoin(gid, uid) {
    const c = cfg(gid);
    if (!c.raid.on) return false;
    const now = Date.now();
    const list = (joins.get(gid) || []).filter((j) => now - j.t < c.raid.sec * 1000);
    list.push({ uid, t: now });
    joins.set(gid, list);

    if (locked(gid)) {
      lock(gid, c.raid.lockMin); // saldırı sürüyorsa kilit uzar
      await punish(gid, uid, c.raid.action, 'Raid koruması (sunucu kilitli)');
      return true;
    }
    if (list.length >= c.raid.count) {
      lock(gid, c.raid.lockMin);
      joins.set(gid, []);
      await actions.log(ev('🚨 RAID ALGILANDI', COLORS.bad, [
        ['Giriş', `${list.length} kişi / ${c.raid.sec} sn`],
        ['Kilit', `${c.raid.lockMin} dk`],
        ['İşlem', c.raid.action === 'ban' ? 'Ban' : 'Kick'],
      ]));
      let ok = 0;
      for (const j of list) { if (await punish(gid, j.uid, c.raid.action, 'Raid koruması')) ok++; await sleep(150); }
      await actions.log(ev('🛡️ Raid müdahalesi', COLORS.warn, [['Cezalandırılan', `${ok}/${list.length}`]]));
      return true;
    }
    return false;
  }

  // ---------- Nuke: ham olaylar ----------
  const KINDS = [
    [/CHANNEL_DELETE/i, 'kanal silme', 1], [/ROLE_DELETE/i, 'rol silme', 1], [/BAN_ADD/i, 'ban', 1],
    [/CHANNEL_CREATE/i, 'kanal açma', 0.5], [/ROLE_CREATE/i, 'rol açma', 0.5],
  ];
  function actorOf(d) {
    const v = d.executor_id ?? d.executorId ?? d.actor_id ?? d.actorId ?? d.moderator_id ?? d.moderatorId
      ?? d.deleted_by ?? d.executor?.id ?? d.actor?.id ?? d.moderator?.id ?? null;
    return v != null ? String(v) : null;
  }
  async function onDestructive(gid, kind, w, d) {
    const c = cfg(gid);
    if (!c.nuke.on) return;
    const actor = actorOf(d);
    if (actor && trusted(gid, actor)) return;
    const key = `${gid}:${actor ?? '?'}`;
    const now = Date.now();
    const arr = (evs.get(key) || []).filter((e) => now - e.t < c.nuke.sec * 1000);
    arr.push({ t: now, w });
    evs.set(key, arr);
    const sum = arr.reduce((a, e) => a + e.w, 0);
    if (sum < c.nuke.count || now - (alarmed.get(key) || 0) < 60_000) return;
    alarmed.set(key, now);
    evs.delete(key);
    lock(gid, c.raid.lockMin); // yeni giriş de durur

    if (actor) {
      const ok = await punish(gid, actor, 'ban', `Nuke koruması (${kind})`);
      await actions.log(ev('💥 NUKE ENGELLENDİ', COLORS.bad, [
        ['Kullanıcı', who(actor)], ['Son işlem', kind], ['Puan', `${sum}/${c.nuke.count} (${c.nuke.sec} sn)`],
        ['İşlem', ok ? 'Banlandı' : 'BANLANAMADI (botun rolü yetersiz olabilir)'],
      ]));
    } else {
      await actions.log(ev('💥 NUKE ŞÜPHESİ', COLORS.bad, [
        ['Son işlem', kind], ['Puan', `${sum}/${c.nuke.count} (${c.nuke.sec} sn)`],
        ['Aktör', 'Tespit edilemedi'], ['İşlem', `Sunucu ${c.raid.lockMin} dk kilitlendi, yetkilileri kontrol edin`],
      ]));
    }
  }
  client.on('raw', (pkt) => {
    const t = String(pkt?.t ?? '');
    const k = KINDS.find(([re]) => re.test(t));
    if (!k) return;
    const d = pkt.d ?? {};
    const gid = String(d.guild_id ?? d.guildId ?? '');
    if (!gid) return;
    onDestructive(gid, k[1], k[2], d).catch((e) => console.warn('[koruma]', e?.message));
  });

  // ---------- Toplu ban/kick limiti (komutla) ----------
  for (const fn of ['ban', 'kick']) {
    const orig = actions[fn].bind(actions);
    actions[fn] = async (message, uid, ...rest) => {
      const gid = guildIdOf(message);
      const by = message?.author?.id && String(message.author.id);
      if (gid && by && message.__cmd && cfg(gid).limit.on && !trusted(gid, by)) {
        const l = cfg(gid).limit, now = Date.now(), k = `${gid}:${by}`;
        const arr = (modHits.get(k) || []).filter((t) => now - t < l.sec * 1000);
        if (arr.length >= l.count) {
          modHits.set(k, arr);
          console.warn(`[koruma] ${by} ban/kick limitine takıldı`);
          await actions.log(ev('⛔ Toplu işlem engellendi', COLORS.warn, [
            ['Yetkili', who(by)], ['Limit', `${l.count} işlem / ${l.sec} sn`], ['İşlem', fn],
          ]));
          return false;
        }
        arr.push(now);
        modHits.set(k, arr);
      }
      return orig(message, uid, ...rest);
    };
  }

  // ---------- Komut ----------
  const onoff = (v) => (['ac', 'aç', 'on'].includes(trLower(v)) ? true : ['kapat', 'off'].includes(trLower(v)) ? false : null);
  const st = (v) => (v ? '✅ Açık' : '❌ Kapalı');

  commands.koruma = async function koruma(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const c = cfg(gid);
    const sub = trLower(args[0]);
    const usage = 'Kullanım:\n`!koruma raid ac|kapat` • `raid esik <kişi> <sn>` • `raid islem kick|ban` • `raid sure <dk>`\n`!koruma nuke ac|kapat` • `nuke esik <puan> <sn>`\n`!koruma limit ac|kapat` • `limit esik <sayı> <sn>`\n`!koruma kilit ac|kapat`\n`!koruma beyaz ekle|sil <kullanıcı>`';

    if (sub) {
      // ayar değiştirmek sadece sunucu sahibi / bot yetkilileri
      if (!isOwnerOf(message)) return message.reply('Koruma ayarlarını sadece sunucu sahibi değiştirebilir.');
      const act = trLower(args[1]);
      let done = true;
      if (sub === 'raid') {
        if (onoff(act) !== null) c.raid.on = onoff(act);
        else if (act === 'esik') {
          const a = num(args[2], 2, 100), b = num(args[3], 3, 300);
          if (a === null || b === null) return message.reply('Kullanım: !koruma raid esik <kişi 2-100> <sn 3-300>');
          c.raid.count = a; c.raid.sec = b;
        } else if (act === 'islem') {
          const v = trLower(args[2]);
          if (!['kick', 'ban'].includes(v)) return message.reply('Kullanım: !koruma raid islem <kick|ban>');
          c.raid.action = v;
        } else if (act === 'sure') {
          const v = num(args[2], 1, 1440);
          if (v === null) return message.reply('Kullanım: !koruma raid sure <dakika 1-1440>');
          c.raid.lockMin = v;
        } else done = false;
      } else if (sub === 'nuke') {
        if (onoff(act) !== null) c.nuke.on = onoff(act);
        else if (act === 'esik') {
          const a = num(args[2], 1, 50), b = num(args[3], 3, 300);
          if (a === null || b === null) return message.reply('Kullanım: !koruma nuke esik <puan 1-50> <sn 3-300>');
          c.nuke.count = a; c.nuke.sec = b;
        } else done = false;
      } else if (sub === 'limit') {
        if (onoff(act) !== null) c.limit.on = onoff(act);
        else if (act === 'esik') {
          const a = num(args[2], 1, 50), b = num(args[3], 5, 600);
          if (a === null || b === null) return message.reply('Kullanım: !koruma limit esik <sayı 1-50> <sn 5-600>');
          c.limit.count = a; c.limit.sec = b;
        } else done = false;
      } else if (sub === 'kilit') {
        const v = onoff(act);
        if (v === null) return message.reply('Kullanım: !koruma kilit <ac|kapat>');
        if (v) lock(gid, c.raid.lockMin); else locks.delete(gid);
      } else if (sub === 'beyaz') {
        const id = resolveUserIds(message, args[2])[0];
        if (!id || !['ekle', 'sil'].includes(act)) return message.reply('Kullanım: !koruma beyaz <ekle|sil> <kullanıcı>');
        c.white = act === 'ekle' ? [...new Set([...c.white, id])] : c.white.filter((x) => x !== id);
      } else done = false;
      if (!done) return message.reply(usage);
      save();
      await actions.log(ev('🛡️ Koruma ayarı değişti', COLORS.warn, [['Ayar', `${sub} ${args.slice(1).join(' ')}`.slice(0, 100)], ['Yetkili', who(String(message.author.id))]]));
    }

    const left = locked(gid) ? `🔒 Kilitli (${Math.ceil((locks.get(gid) - Date.now()) / 60000)} dk kaldı)` : '🔓 Kilit yok';
    return sendPanel(message, { embeds: [ev('🛡️ Raid & Nuke Koruması', COLORS.main, [
      ['🚨 Raid', `${st(c.raid.on)}\n${c.raid.sec} sn'de ${c.raid.count}+ giriş\nİşlem: ${c.raid.action}\nKilit: ${c.raid.lockMin} dk`],
      ['💥 Nuke', `${st(c.nuke.on)}\n${c.nuke.sec} sn'de ${c.nuke.count} puan\n(silme/ban=1, açma=0.5)`],
      ['⛔ Ban/kick limiti', `${st(c.limit.on)}\n${c.limit.sec} sn'de ${c.limit.count} işlem`],
      ['Durum', left],
      ['✅ Beyaz liste', c.white.length ? c.white.map((i) => `<@${i}>`).join(' ') : 'Yok (sunucu sahibi ve bot yetkilileri zaten muaf)', false],
      ['Komutlar', usage, false],
    ])] });
  };

  const oldF = HELP_PAGES.filter;
  HELP_PAGES.filter = () => {
    const p = oldF ? oldF() : { title: '🛡️ Filtre Komutları', color: COLORS.main, fields: [] };
    p.fields.push({ name: '🚨 Raid & Nuke koruması', value: '`!koruma` panel • `raid` • `nuke` • `limit` • `kilit` • `beyaz`', inline: false });
    return p;
  };

  return { onJoin, flush };
}

module.exports = { init };