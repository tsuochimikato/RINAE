// RINAE - Çekiliş modülü (butonlu panel sürümü)
// index.js ile aynı klasöre koy. Veriler cekilis.json dosyasında tutulur.
//
// Panel:  !cekilis (yöneticiler panel açar, diğerleri aktif çekilişleri görür) veya !cekilis-panel
//         Süre, kazanan sayısı, kanal ve başlatma butonlarla yapılır.
//         Ödül, özel süre, özel kazanan sayısı ve rol şartı için butona basınca mesaj yazman istenir.
// Yazılı komutlar (yedek):
//   !cekilis-baslat <süre> <kazanan sayısı> <ödül> [--rol <rolID>]
//   !cekilis-bitir <no> • !cekilis-iptal <no> • !cekilis-yeniden <no> [n]
//   !cekilis-liste • !cekilis-katil <no> • !cekilis-ayril <no>
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'cekilis.json');
const TR_TZ = 'Europe/Istanbul';
const MIN_MS = 10_000;
const MAX_MS = 30 * 864e5;
const DRAFT_TTL = 15 * 60_000;
const INPUT_TTL = 2 * 60_000;

const UNITS = { sn: 1e3, dk: 6e4, m: 6e4, sa: 36e5, h: 36e5, g: 864e5, d: 864e5, hf: 6048e5, w: 6048e5 };
const UNIT_RE = /(\d+)\s*(sn|dk|sa|hf|m|h|g|d|w)/g;
const PRESETS = [['10dk', 6e5], ['30dk', 18e5], ['1sa', 36e5], ['6sa', 216e5], ['12sa', 432e5], ['1g', 864e5], ['3g', 2592e5], ['1hf', 6048e5]];
const WIN_PRESETS = [1, 2, 3, 5];

function parseDuration(text) {
  const s = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let total = 0;
  for (const m of s.matchAll(UNIT_RE)) total += Number(m[1]) * UNITS[m[2]];
  if (!total || s.replace(UNIT_RE, '') !== '') return null;
  return total;
}

const fmtTime = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: TR_TZ });
const fmtLeft = (ms) => {
  const m = Math.max(0, Math.ceil(ms / 60000));
  if (m < 1) return '1 dakikadan az';
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  return [d ? `${d} gün` : '', h ? `${h} sa` : '', mi ? `${mi} dk` : ''].filter(Boolean).join(' ');
};
const plainJson = (x) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x);
const toRaw = (body) => JSON.parse(JSON.stringify({ ...body, components: (body.components ?? []).map(plainJson) }));

// ---------- Kalıcı veri ----------
function load() {
  const def = { list: [], nextId: 1 };
  for (const f of [FILE, FILE + '.bak']) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
      if (Array.isArray(j.list)) def.list = j.list;
      if (Number.isInteger(j.nextId)) def.nextId = j.nextId;
      return def;
    } catch { /* sıradakini dene */ }
  }
  return def;
}

function init(ctx) {
  const {
    client, commands, HELP_PAGES, postToChannel, makeRow, sendPanel, respondUpdate, respondPrivate,
    requirePerm, guildIdOf, cleanId, COLORS, ADMIN_ONLY, actions, ev, who, ek, plus, isOwnerOf,
  } = ctx;

  const D = load();
  const save = () => {
    try {
      const text = JSON.stringify(D);
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, text, 'utf-8');
      if (fs.existsSync(FILE)) { try { fs.copyFileSync(FILE, FILE + '.bak'); } catch { /* yoksay */ } }
      fs.renameSync(tmp, FILE);
    } catch (e) { console.warn('cekilis.json kaydedilemedi:', e.message); }
  };
  const uidOf = (m) => String(m.author.id);
  const find = (gid, id) => D.list.find((g) => g.gid === gid && g.id === Number(id));
  const needAdmin = (m) => requirePerm(m, 'Administrator', ADMIN_ONLY);
  const isStaffId = async (gid, uid) => plus.isSuper(uid) || (await ek.isAdminId(gid, uid));
  const isStaffMsg = async (m) => plus.isSuper(uidOf(m)) || isOwnerOf(m) || (await ek.isAdmin(m));

  // ---------- Rol şartı kontrolü ----------
  async function hasRole(gid, uid, roleId, interaction) {
    const ids = new Set();
    const eat = (r) => {
      if (!r) return;
      const add = (v) => { if (v != null) ids.add(String(typeof v === 'object' ? v.id : v)); };
      if (Array.isArray(r)) r.forEach(add);
      else if (r.cache?.forEach) r.cache.forEach((v, k) => add(v?.id ?? k));
      else if (typeof r.forEach === 'function') r.forEach((v, k) => add(v?.id ?? k));
    };
    const m = interaction?.member;
    eat(m?.roles ?? m?.roleIds ?? m?.role_ids);
    if (!ids.size) {
      try {
        const mem = await client.rest.getMember(gid, uid);
        eat(mem?.roles ?? mem?.role_ids ?? mem?.member?.roles);
      } catch { /* yoksay */ }
    }
    return ids.has(String(roleId));
  }

  // ---------- Çekiliş mesajı ----------
  function payload(g) {
    const open = g.status === 'active';
    const fields = [
      { name: '🎁 Ödül', value: g.prize, inline: false },
      { name: '🏆 Kazanan sayısı', value: String(g.winnersCount), inline: true },
      { name: '👥 Katılımcı', value: String(g.participants.length), inline: true },
    ];
    if (open) {
      fields.push({ name: '🕒 Bitiş', value: `${fmtTime(g.endAt)}\n(${fmtLeft(g.endAt - Date.now())} sonra)`, inline: true });
    } else if (g.status === 'ended') {
      fields.push({
        name: '🎊 Kazananlar',
        value: g.winners.length ? g.winners.map((u) => `<@${u}>`).join(' ') : 'Katılım olmadığı için kazanan yok',
        inline: false,
      });
    }
    if (g.requiredRoleId) fields.push({ name: '🔒 Şart', value: `<@&${g.requiredRoleId}> rolüne sahip olmalısın`, inline: false });
    fields.push({ name: 'Düzenleyen', value: who(g.hostId), inline: true });

    return {
      embeds: [{
        title: `🎉 ÇEKİLİŞ #${g.id}${g.status === 'cancelled' ? ' • İPTAL' : g.status === 'ended' ? ' • BİTTİ' : ''}`,
        color: open ? COLORS.main : g.status === 'cancelled' ? COLORS.bad : COLORS.ok,
        description: open
          ? `Katılmak için aşağıdaki **🎉 Katıl** butonuna bas.\nButon çalışmazsa \`!cekilis-katil ${g.id}\` yaz.`
          : 'Bu çekiliş sona erdi.',
        fields,
        footer: { text: 'RINAE • Çekiliş' },
      }],
      components: open ? [makeRow([
        { id: `cek:join:${g.id}`, label: '🎉 Katıl', style: 'Success' },
        { id: `cek:leave:${g.id}`, label: '❌ Ayrıl', style: 'Danger' },
      ])] : [],
    };
  }

  async function postGiveaway(g) {
    const body = payload(g);
    try {
      const res = await client.rest.request('POST', `/bot/guilds/${g.gid}/channels/${g.channelId}/messages`, toRaw(body));
      g.messageId = String(res?.id ?? res?.data?.id ?? res?.message?.id ?? '') || null;
      return true;
    } catch (e) {
      console.warn('[çekiliş] REST gönderimi başarısız, yedek yöntem deneniyor:', e?.message || e);
      return postToChannel(g.gid, g.channelId, body);
    }
  }

  async function refreshMessage(g) {
    if (!g.messageId) return;
    try {
      await client.rest.request('PATCH', `/bot/guilds/${g.gid}/channels/${g.channelId}/messages/${g.messageId}`, toRaw(payload(g)));
    } catch { /* yoksay */ }
  }

  // ---------- Çekiliş işlemleri ----------
  function pickWinners(pool, n) {
    const a = [...pool];
    const out = [];
    while (out.length < n && a.length) out.push(a.splice(crypto.randomInt(a.length), 1)[0]);
    return out;
  }

  async function announce(g, winners, reroll = false) {
    const text = winners.length
      ? `🎊 Tebrikler ${winners.map((u) => `<@${u}>`).join(' ')}! **${g.prize}** ödülünü kazandın${winners.length > 1 ? 'ız' : ''}! (Çekiliş #${g.id})`
      : `😢 **${g.prize}** çekilişine kimse katılmadığı için kazanan çıkmadı. (Çekiliş #${g.id})`;
    await postToChannel(g.gid, g.channelId, {
      content: text,
      embeds: reroll ? undefined : [{ title: `🏁 Çekiliş #${g.id} sona erdi`, description: `Ödül: **${g.prize}**\nKatılımcı: **${g.participants.length}**`, color: COLORS.ok }],
    });
  }

  async function createGiveaway({ gid, channelId, hostId, prize, ms, winnersCount, requiredRoleId }) {
    const g = {
      id: D.nextId++, gid, channelId, messageId: null, prize, winnersCount, requiredRoleId: requiredRoleId ?? null,
      hostId, createdAt: Date.now(), endAt: Date.now() + ms, status: 'active', participants: [], winners: [], endedAt: null,
    };
    D.list.push(g);
    const ok = await postGiveaway(g);
    save();
    if (ok) {
      await actions.log(ev('🎉 Çekiliş başlatıldı', COLORS.ok, [
        ['Çekiliş', `#${g.id} ${g.prize}`], ['Bitiş', fmtTime(g.endAt)], ['Kazanan', g.winnersCount], ['Yetkili', who(hostId)],
      ]));
    }
    return { g, ok };
  }

  async function endGiveaway(g, by = null) {
    if (g.status !== 'active') return false;
    g.status = 'ended';
    g.endedAt = Date.now();
    g.winners = pickWinners(g.participants, g.winnersCount);
    save();
    await refreshMessage(g);
    await announce(g, g.winners);
    await actions.log(ev('🏁 Çekiliş bitti', COLORS.ok, [
      ['Çekiliş', `#${g.id} ${g.prize}`], ['Katılımcı', g.participants.length],
      ['Kazananlar', g.winners.map((u) => `<@${u}>`).join(' ') || '—', false], by ? ['Bitiren', who(by)] : null,
    ]));
    return true;
  }

  async function cancelGiveaway(g, by) {
    if (g.status !== 'active') return false;
    g.status = 'cancelled';
    g.endedAt = Date.now();
    save();
    await refreshMessage(g);
    await actions.log(ev('⛔ Çekiliş iptal edildi', COLORS.warn, [['Çekiliş', `#${g.id} ${g.prize}`], ['Yetkili', who(by)]]));
    return true;
  }

  async function rerollGiveaway(g, n, by) {
    if (g.status !== 'ended') return { error: 'Sadece bitmiş çekilişlerde yeniden çekim yapılabilir.' };
    const pool = g.participants.filter((u) => !g.winners.includes(u));
    if (!pool.length) return { error: 'Yeniden çekilebilecek başka katılımcı kalmadı.' };
    const fresh = pickWinners(pool, Math.min(20, Math.max(1, n || 1)));
    g.winners.push(...fresh);
    save();
    await refreshMessage(g);
    await announce(g, fresh, true);
    await actions.log(ev('🔁 Çekiliş yeniden çekildi', COLORS.warn, [
      ['Çekiliş', `#${g.id} ${g.prize}`], ['Yeni kazanan', fresh.map((u) => `<@${u}>`).join(' ')], ['Yetkili', who(by)],
    ]));
    return { fresh };
  }

  // ---------- Zamanlayıcı ----------
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      for (const g of D.list) if (g.status === 'active' && now >= g.endAt) await endGiveaway(g);
      const old = now - 60 * 864e5;
      const before = D.list.length;
      D.list = D.list.filter((g) => g.status === 'active' || (g.endedAt ?? g.createdAt) > old);
      if (D.list.length !== before) save();
      for (const [k, d] of drafts) if (now - d.last > DRAFT_TTL) drafts.delete(k);
    } catch (e) { console.warn('[çekiliş] tick:', e?.message || e); }
    finally { ticking = false; }
  }
  setInterval(tick, 15_000).unref?.();
  setTimeout(tick, 5_000).unref?.();

  // =====================================================================
  // BUTONLU PANEL
  // =====================================================================
  const drafts = new Map(); // "gid:uid" -> taslak (bellekte)
  function draftOf(gid, uid, channelId) {
    const k = `${gid}:${uid}`;
    let d = drafts.get(k);
    if (!d) {
      d = { prize: null, durationMs: null, winners: 1, requiredRoleId: null, channelId: channelId ?? null, awaiting: null, panelMsgId: null, panelChannelId: null, last: 0 };
      drafts.set(k, d);
    }
    if (!d.channelId && channelId) d.channelId = channelId;
    d.last = Date.now();
    return d;
  }
  const sel = (c) => (c ? 'Success' : 'Secondary');
  const idOf = (uid) => (a, arg = '') => `cek:p:${a}:${arg}:${uid}`;

  const PROMPTS = {
    prize: '✏️ Şimdi **ödülü** bu kanala yaz (en fazla 100 karakter).',
    duration: '⏱️ Şimdi **süreyi** bu kanala yaz. Örnek: `45dk`, `2sa`, `1g`, `1sa30dk` (10 sn - 30 gün)',
    winners: '🔢 Şimdi **kazanan sayısını** yaz (1-20).',
    role: '🔒 Şimdi **rolü etiketle** ya da rol ID\'sini yaz.',
  };

  function panelMain(gid, uid, notice) {
    const d = draftOf(gid, uid, null);
    const id = idOf(uid);
    const active = D.list.filter((g) => g.gid === gid && g.status === 'active').length;
    const customDur = d.durationMs != null && !PRESETS.some(([, ms]) => ms === d.durationMs);

    const rows = [
      makeRow(PRESETS.slice(0, 5).map(([l, ms]) => ({ id: id('dur', ms), label: l, style: sel(d.durationMs === ms) }))),
      makeRow([
        ...PRESETS.slice(5).map(([l, ms]) => ({ id: id('dur', ms), label: l, style: sel(d.durationMs === ms) })),
        { id: id('durx'), label: '⏱️ Özel süre', style: sel(customDur) },
      ]),
      makeRow([
        ...WIN_PRESETS.map((n) => ({ id: id('win', n), label: `${n} kazanan`, style: sel(d.winners === n) })),
        { id: id('winx'), label: '🔢 Özel', style: sel(!WIN_PRESETS.includes(d.winners)) },
      ]),
      makeRow([
        { id: id('prize'), label: '🎁 Ödülü Yaz', style: d.prize ? 'Success' : 'Primary' },
        { id: id('role'), label: '🔒 Rol Şartı', style: sel(d.requiredRoleId) },
        { id: id('norole'), label: '🚫 Şartı Kaldır', style: 'Secondary' },
        { id: id('here'), label: '📍 Bu Kanal', style: 'Secondary' },
      ]),
      makeRow([
        { id: id('start'), label: '✅ Çekilişi Başlat', style: 'Primary' },
        { id: id('reset'), label: '🧹 Sıfırla', style: 'Danger' },
        { id: id('list'), label: `📋 Çekilişler (${active})`, style: 'Secondary' },
        { id: id('close'), label: '✖ Kapat', style: 'Secondary' },
      ]),
    ];

    const lines = [];
    if (notice) lines.push(notice);
    if (d.awaiting) lines.push(`${PROMPTS[d.awaiting.kind]}\nVazgeçmek için \`iptal\` yaz (2 dk içinde).`);
    if (!lines.length) lines.push('Süreyi ve kazanan sayısını butonlarla seç, ödülü yaz, sonra **Çekilişi Başlat**\'a bas.\nSeçili olanlar yeşil görünür.');

    return {
      embeds: [{
        title: '🎁 Çekiliş Paneli',
        description: lines.join('\n\n'),
        color: COLORS.main,
        fields: [
          { name: '🎁 Ödül', value: d.prize ?? 'Seçilmedi', inline: false },
          { name: '⏱️ Süre', value: d.durationMs ? fmtLeft(d.durationMs) : 'Seçilmedi', inline: true },
          { name: '🏆 Kazanan', value: String(d.winners), inline: true },
          { name: '🔒 Rol şartı', value: d.requiredRoleId ? `<@&${d.requiredRoleId}>` : 'Yok', inline: true },
          { name: '📍 Kanal', value: d.channelId ? `<#${d.channelId}>` : 'Belirsiz (📍 Bu Kanal\'a bas)', inline: true },
        ],
        footer: { text: 'Sadece sunucu sahibi ve yöneticiler kullanabilir' },
      }],
      components: rows,
    };
  }

  function panelList(gid, uid, notice) {
    const id = idOf(uid);
    const actives = D.list.filter((g) => g.gid === gid && g.status === 'active').slice(-5);
    const ended = D.list.filter((g) => g.gid === gid && g.status === 'ended')
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0)).slice(0, 5);
    const fields = [];
    for (const g of actives) {
      fields.push({ name: `🟢 #${g.id} • ${g.prize}`, value: `Bitiş: ${fmtTime(g.endAt)} (${fmtLeft(g.endAt - Date.now())} sonra)\n👥 ${g.participants.length} • <#${g.channelId}>`, inline: false });
    }
    for (const g of ended) {
      fields.push({ name: `🏁 #${g.id} • ${g.prize}`, value: `Kazananlar: ${g.winners.map((u) => `<@${u}>`).join(' ') || '—'}`, inline: false });
    }
    const rows = [];
    if (actives.length) rows.push(makeRow(actives.map((g) => ({ id: id('m', g.id), label: `#${g.id} ${g.prize.slice(0, 14)}`, style: 'Primary' }))));
    if (ended.length) rows.push(makeRow(ended.map((g) => ({ id: id('m', g.id), label: `🏁 #${g.id}`, style: 'Secondary' }))));
    rows.push(makeRow([{ id: id('home'), label: '◀ Geri', style: 'Secondary' }]));
    return {
      embeds: [{
        title: '📋 Çekilişler',
        description: [notice, fields.length ? 'Yönetmek istediğin çekilişin butonuna bas.' : 'Henüz çekiliş yok.'].filter(Boolean).join('\n\n'),
        color: COLORS.main,
        fields,
      }],
      components: rows,
    };
  }

  function panelManage(g, uid, notice, confirmCancel = false) {
    const id = idOf(uid);
    const base = payload(g).embeds[0];
    const embed = { ...base, description: [notice, confirmCancel ? '⚠️ Bu çekilişi iptal etmek istediğine emin misin?' : null].filter(Boolean).join('\n\n') || undefined };
    let buttons;
    if (confirmCancel) {
      buttons = [{ id: id('cancelok', g.id), label: '⛔ Evet, iptal et', style: 'Danger' }, { id: id('m', g.id), label: 'Vazgeç', style: 'Secondary' }];
    } else if (g.status === 'active') {
      buttons = [{ id: id('end', g.id), label: '🏁 Şimdi Bitir', style: 'Success' }, { id: id('cancel', g.id), label: '⛔ İptal Et', style: 'Danger' }];
    } else if (g.status === 'ended') {
      buttons = [{ id: id('reroll', g.id), label: '🔁 Yeniden Çek (1 kişi)', style: 'Primary' }];
    } else buttons = [];
    const rows = [];
    if (buttons.length) rows.push(makeRow(buttons));
    rows.push(makeRow([{ id: id('list'), label: '◀ Listeye Dön', style: 'Secondary' }]));
    return { embeds: [embed], components: rows };
  }

  // Panel üzerindeki butonlar: cek:p:<işlem>:<arg>:<sahip>
  async function handlePanel(interaction, parts) {
    const [, , action, arg, owner] = parts;
    const gid = interaction.guildId ?? interaction.guild?.id;
    const uid = String(interaction.user?.id ?? interaction.member?.user?.id ?? interaction.userId ?? '');
    const chId = interaction.channelId ?? interaction.channel?.id ?? interaction.channel_id ?? null;
    if (!gid || !uid) return respondPrivate(interaction, 'Bir sorun oluştu, `!cekilis` yazarak tekrar dene.');
    if (owner && owner !== uid) return respondPrivate(interaction, 'Bu paneli sen açmadın. Kendi paneli için `!cekilis` yaz.');
    if (!(await isStaffId(gid, uid))) return respondPrivate(interaction, 'Bu panel sadece sunucu sahibi ve yöneticiler içindir.');

    const d = draftOf(gid, uid, chId);
    const upd = (p) => respondUpdate(interaction, p);

    if (action === 'open') { // başka sayfalardaki "🎁 Çekiliş" butonu: sadece sana görünen panel açar
      d.panelMsgId = null;
      return respondPrivate(interaction, panelMain(gid, uid));
    }
    d.panelMsgId = interaction.message?.id ?? interaction.messageId ?? interaction.message_id ?? null;
    d.panelChannelId = chId;

    switch (action) {
      case 'home': return upd(panelMain(gid, uid));
      case 'dur': {
        const ms = Number(arg);
        if (ms >= MIN_MS && ms <= MAX_MS) d.durationMs = ms;
        d.awaiting = null;
        return upd(panelMain(gid, uid));
      }
      case 'win': {
        const n = Number(arg);
        if (n >= 1 && n <= 20) d.winners = n;
        d.awaiting = null;
        return upd(panelMain(gid, uid));
      }
      case 'durx': case 'winx': case 'prize': case 'role': {
        const kind = { durx: 'duration', winx: 'winners', prize: 'prize', role: 'role' }[action];
        d.awaiting = { kind, channelId: chId, until: Date.now() + INPUT_TTL };
        return upd(panelMain(gid, uid));
      }
      case 'norole': d.requiredRoleId = null; return upd(panelMain(gid, uid, 'Rol şartı kaldırıldı.'));
      case 'here':
        if (chId) { d.channelId = chId; return upd(panelMain(gid, uid, 'Çekiliş bu kanalda başlatılacak.')); }
        return upd(panelMain(gid, uid, '⚠️ Kanal bilgisi okunamadı. Paneli çekilişin yapılacağı kanalda `!cekilis` ile aç.'));
      case 'reset': {
        const keep = d.channelId;
        drafts.delete(`${gid}:${uid}`);
        draftOf(gid, uid, keep);
        return upd(panelMain(gid, uid, 'Taslak sıfırlandı.'));
      }
      case 'close': return upd({ embeds: [{ title: '🎁 Çekiliş paneli kapatıldı', color: COLORS.main }], components: [] });
      case 'start': {
        if (!d.prize) return upd(panelMain(gid, uid, '⚠️ Önce **Ödülü Yaz** butonuyla ödülü gir.'));
        if (!d.durationMs) return upd(panelMain(gid, uid, '⚠️ Önce bir **süre** seç.'));
        if (!d.channelId) return upd(panelMain(gid, uid, '⚠️ Kanal belirsiz. **📍 Bu Kanal** butonuna bas.'));
        const { g, ok } = await createGiveaway({
          gid, channelId: d.channelId, hostId: uid, prize: d.prize, ms: d.durationMs,
          winnersCount: d.winners, requiredRoleId: d.requiredRoleId,
        });
        if (!ok) return upd(panelMain(gid, uid, '⚠️ Çekiliş mesajı gönderilemedi. Botun o kanalda yazma yetkisini kontrol et.'));
        const keep = d.channelId;
        drafts.delete(`${gid}:${uid}`);
        draftOf(gid, uid, keep);
        return upd(panelMain(gid, uid, `✅ Çekiliş **#${g.id}** başlatıldı! (<#${g.channelId}>)`));
      }
      case 'list': return upd(panelList(gid, uid));
      default: break;
    }

    // Çekiliş yönetimi
    const g = find(gid, arg);
    if (!g) return upd(panelList(gid, uid, '⚠️ Çekiliş bulunamadı.'));
    switch (action) {
      case 'm': return upd(panelManage(g, uid));
      case 'end': {
        const ok = await endGiveaway(g, uid);
        return upd(panelManage(g, uid, ok ? '🏁 Çekiliş bitirildi, kazananlar duyuruldu.' : 'Bu çekiliş zaten sona ermiş.'));
      }
      case 'cancel': return upd(panelManage(g, uid, null, true));
      case 'cancelok': {
        const ok = await cancelGiveaway(g, uid);
        return upd(panelManage(g, uid, ok ? '⛔ Çekiliş iptal edildi.' : 'Bu çekiliş zaten sona ermiş.'));
      }
      case 'reroll': {
        const r = await rerollGiveaway(g, 1, uid);
        return upd(panelManage(g, uid, r.error ? `⚠️ ${r.error}` : `🔁 Yeni kazanan: ${r.fresh.map((u) => `<@${u}>`).join(' ')}`));
      }
      default: return undefined;
    }
  }

  // Panelin istediği yazılı cevapları yakalar (index.js messageCreate başında çağrılır)
  async function onMessage(message) {
    const gid = guildIdOf(message);
    if (!gid || !message.author) return false;
    const uid = uidOf(message);
    const d = drafts.get(`${gid}:${uid}`);
    const a = d?.awaiting;
    if (!a) return false;
    if (Date.now() > a.until) { d.awaiting = null; return false; }
    if (a.channelId && message.channelId !== a.channelId) return false;

    const text = String(message.content ?? '').trim();
    d.awaiting = null;
    d.last = Date.now();
    await actions.deleteMessage(message);

    let notice;
    if (/^(iptal|vazgec|vazgeç)$/i.test(text)) notice = 'İşlem iptal edildi.';
    else if (a.kind === 'prize') {
      const clean = text.replace(/<@[!&]?\d+>/g, '').replace(/@/g, '@\u200b').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (clean) { d.prize = clean; notice = `Ödül ayarlandı: **${clean}**`; } else notice = '⚠️ Geçersiz ödül, tekrar dene.';
    } else if (a.kind === 'duration') {
      const ms = parseDuration(text);
      if (!ms) notice = '⚠️ Süre anlaşılamadı. Örnek: `45dk`, `2sa`, `1g`, `1sa30dk`';
      else if (ms < MIN_MS) notice = '⚠️ Süre en az 10 saniye olmalı.';
      else if (ms > MAX_MS) notice = '⚠️ Süre en fazla 30 gün olabilir.';
      else { d.durationMs = ms; notice = `Süre ayarlandı: **${fmtLeft(ms)}**`; }
    } else if (a.kind === 'winners') {
      const n = Number(text);
      if (Number.isInteger(n) && n >= 1 && n <= 20) { d.winners = n; notice = `Kazanan sayısı: **${n}**`; } else notice = '⚠️ 1 ile 20 arasında bir sayı yazmalısın.';
    } else if (a.kind === 'role') {
      const r = cleanId(text);
      if (/^\d{1,25}$/.test(r)) { d.requiredRoleId = r; notice = `Rol şartı: <@&${r}>`; } else notice = '⚠️ Geçerli bir rol etiketi ya da ID yaz.';
    }

    const body = panelMain(gid, uid, notice);
    let edited = false;
    if (d.panelMsgId && d.panelChannelId) {
      try {
        await client.rest.request('PATCH', `/bot/guilds/${gid}/channels/${d.panelChannelId}/messages/${d.panelMsgId}`, toRaw(body));
        edited = true;
      } catch { /* yeni panel gönderilecek */ }
    }
    if (!edited) await postToChannel(gid, a.channelId ?? message.channelId, body);
    return true;
  }

  // ---------- Buton yönlendirmesi ----------
  // cek:p:... panel • cek:join:<no> / cek:leave:<no> çekilişe katılma
  async function handleInteraction(interaction, customId) {
    const parts = customId.split(':');
    if (parts[1] === 'p') return handlePanel(interaction, parts);

    const [, action, id] = parts;
    const gid = interaction.guildId ?? interaction.guild?.id;
    const uid = String(interaction.user?.id ?? interaction.member?.user?.id ?? interaction.userId ?? '');
    if (!gid || !uid) return respondPrivate(interaction, `Bir sorun oluştu, \`!cekilis-katil ${id}\` ile katılabilirsin.`);
    const g = find(gid, id);
    if (!g) return respondPrivate(interaction, 'Bu çekiliş bulunamadı.');
    if (g.status !== 'active') return respondPrivate(interaction, 'Bu çekiliş artık aktif değil.');
    if (Date.now() >= g.endAt) return respondPrivate(interaction, 'Bu çekilişin süresi doldu, sonuç birazdan açıklanacak.');

    if (action === 'join') {
      if (g.participants.includes(uid)) return respondPrivate(interaction, 'Zaten bu çekilişe katıldın 🎉');
      if (g.requiredRoleId && !(await hasRole(gid, uid, g.requiredRoleId, interaction))) {
        return respondPrivate(interaction, `Bu çekilişe katılmak için <@&${g.requiredRoleId}> rolüne sahip olmalısın.`);
      }
      g.participants.push(uid);
    } else if (action === 'leave') {
      if (!g.participants.includes(uid)) return respondPrivate(interaction, 'Zaten bu çekilişe katılmamışsın.');
      g.participants = g.participants.filter((u) => u !== uid);
    } else return undefined;
    save();
    return respondUpdate(interaction, payload(g));
  }

  // ---------- Komutlar ----------
  Object.assign(commands, {
    async 'cekilis-panel'(message) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
      const uid = uidOf(message);
      const d = draftOf(gid, uid, message.channelId);
      d.channelId = message.channelId;
      d.panelMsgId = null;
      return sendPanel(message, panelMain(gid, uid));
    },

    async 'cekilis-baslat'(message, args) {
      if (!(await needAdmin(message))) return;
      const gid = guildIdOf(message);
      if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
      const usage = 'Kullanım: !cekilis-baslat <süre> <kazanan sayısı> <ödül> [--rol <rolID>]\nÖrnek: `!cekilis-baslat 2sa 1 Discord Nitro`\nButonlu panel için: `!cekilis`';
      const rest = [...args];
      let requiredRoleId = null;
      const ri = rest.findIndex((a) => a.toLowerCase() === '--rol');
      if (ri !== -1) {
        const r = cleanId(rest[ri + 1]);
        if (!/^\d{1,25}$/.test(r)) return message.reply('`--rol` yanına geçerli bir rol ID\'si yaz.\n' + usage);
        requiredRoleId = r;
        rest.splice(ri, 2);
      }
      const ms = parseDuration(rest[0]);
      if (!ms) return message.reply(usage);
      if (ms < MIN_MS) return message.reply('Süre en az 10 saniye olmalı.');
      if (ms > MAX_MS) return message.reply('Süre en fazla 30 gün olabilir.');
      let winnersCount = 1, prizeStart = 1;
      if (/^\d+$/.test(rest[1] ?? '')) { winnersCount = Number(rest[1]); prizeStart = 2; }
      if (winnersCount < 1 || winnersCount > 20) return message.reply('Kazanan sayısı 1 ile 20 arasında olmalı.');
      const prize = rest.slice(prizeStart).join(' ').replace(/@/g, '@\u200b').trim().slice(0, 100);
      if (!prize) return message.reply(usage);
      const { ok } = await createGiveaway({ gid, channelId: message.channelId, hostId: uidOf(message), prize, ms, winnersCount, requiredRoleId });
      if (!ok) return message.reply('Çekiliş kaydedildi ama mesaj gönderilemedi. Botun kanalda yazma yetkisini kontrol et.');
    },

    async 'cekilis-bitir'(message, args) {
      if (!(await needAdmin(message))) return;
      const g = find(guildIdOf(message), args[0]);
      if (!g) return message.reply('Kullanım: !cekilis-bitir <no>');
      if (!(await endGiveaway(g, uidOf(message)))) return message.reply('Bu çekiliş zaten sona ermiş.');
    },

    async 'cekilis-iptal'(message, args) {
      if (!(await needAdmin(message))) return;
      const g = find(guildIdOf(message), args[0]);
      if (!g) return message.reply('Kullanım: !cekilis-iptal <no>');
      if (!(await cancelGiveaway(g, uidOf(message)))) return message.reply('Bu çekiliş zaten sona ermiş.');
      return message.reply(`Çekiliş #${g.id} iptal edildi.`);
    },

    async 'cekilis-yeniden'(message, args) {
      if (!(await needAdmin(message))) return;
      const g = find(guildIdOf(message), args[0]);
      if (!g) return message.reply('Kullanım: !cekilis-yeniden <no> [kaç kişi]');
      const r = await rerollGiveaway(g, Number(args[1]) || 1, uidOf(message));
      if (r.error) return message.reply(r.error);
    },

    async 'cekilis-liste'(message) {
      const gid = guildIdOf(message);
      const list = D.list.filter((g) => g.gid === gid && g.status === 'active');
      if (!list.length) return message.reply('Şu an aktif çekiliş yok.');
      return sendPanel(message, {
        embeds: [{
          title: '🎉 Aktif Çekilişler',
          color: COLORS.main,
          fields: list.slice(0, 10).map((g) => ({
            name: `#${g.id} • ${g.prize}`,
            value: `Bitiş: ${fmtTime(g.endAt)} (${fmtLeft(g.endAt - Date.now())} sonra)\n👥 ${g.participants.length} katılımcı • 🏆 ${g.winnersCount} kazanan\n<#${g.channelId}> • \`!cekilis-katil ${g.id}\``,
            inline: false,
          })),
        }],
      });
    },

    async 'cekilis-katil'(message, args) {
      const gid = guildIdOf(message);
      const g = find(gid, args[0]);
      if (!g || g.status !== 'active' || Date.now() >= g.endAt) return message.reply('Katılabileceğin böyle bir çekiliş yok.');
      const uid = uidOf(message);
      if (g.participants.includes(uid)) return message.reply('Zaten bu çekilişe katıldın 🎉');
      if (g.requiredRoleId && !(await hasRole(gid, uid, g.requiredRoleId, message))) {
        return message.reply(`Bu çekilişe katılmak için <@&${g.requiredRoleId}> rolüne sahip olmalısın.`);
      }
      g.participants.push(uid);
      save();
      return message.reply(`**${g.prize}** çekilişine katıldın! 🍀`);
    },

    async 'cekilis-ayril'(message, args) {
      const g = find(guildIdOf(message), args[0]);
      if (!g || g.status !== 'active') return message.reply('Böyle bir çekiliş yok.');
      const uid = uidOf(message);
      if (!g.participants.includes(uid)) return message.reply('Zaten bu çekilişe katılmamışsın.');
      g.participants = g.participants.filter((u) => u !== uid);
      save();
      return message.reply('Çekilişten ayrıldın.');
    },
  });

  // !cekilis: yöneticiye panel, diğerlerine aktif çekiliş listesi
  commands.cekilis = async (message, args) => (
    (await isStaffMsg(message)) ? commands['cekilis-panel'](message, args) : commands['cekilis-liste'](message, args)
  );
  commands['çekiliş'] = commands.cekilis;
  commands['çekiliş-başlat'] = commands['cekilis-baslat'];

  // ---------- Yardım: "🎁 Çekiliş" sekmesi ----------
  HELP_PAGES.giveaway = () => ({
    title: '🎁 Çekiliş Komutları',
    color: COLORS.ok,
    fields: [
      { name: '🎛️ Panel (önerilen)', value: '`!cekilis` yazınca butonlu panel açılır (yöneticiler).\nSüre, kazanan sayısı, kanal ve başlatma butonlarla yapılır. Ödül, özel süre ve rol şartı için butona basıp mesaj yazarsın.', inline: false },
      { name: '⌨️ Yazılı komutlar (yetkili)', value: '`!cekilis-baslat <süre> <kazanan> <ödül> [--rol <rolID>]`\n`!cekilis-bitir <no>` • `!cekilis-iptal <no>` • `!cekilis-yeniden <no> [n]`', inline: false },
      { name: '🙋 Herkes', value: '`!cekilis-liste` • `!cekilis-katil <no>` • `!cekilis-ayril <no>`\nÇekiliş mesajındaki **🎉 Katıl** butonu da aynı işi yapar.', inline: false },
      { name: '⏱️ Süre yazımı', value: '`30dk`, `2sa`, `1g`, `1hf`, `1sa30dk` (10 sn - 30 gün)', inline: false },
    ],
    footer: { text: 'RINAE • Çekiliş' },
  });

  return {
    handleInteraction, onMessage, flush: save,
    // Başka panellere (yönetim, panel vb.) eklenebilecek buton tanımı: makeRow([... , cekilis.panelButton(uid)])
    panelButton: (uid) => ({ id: `cek:p:open::${uid}`, label: '🎁 Çekiliş', style: 'Secondary' }),
  };
}

module.exports = { init };