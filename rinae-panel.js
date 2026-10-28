// RINAE - istatistik paneli köprüsü
// Bot verisinin kişi bazlı olmayan özetini Cloudflare Worker'a gönderir ve
// yöneticilere özel panel linki verir (!istatistik-link).
// .env dosyasına ekle:
//   PANEL_SECRET=wrangler secret put ile girdiğin PUSH_SECRET ile aynı değer
//   PANEL_SITE=https://rinaejubbio.rinean01.workers.dev   (isteğe bağlı, varsayılan bu)
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'panel.json');
const TR = 3 * 3600e3; // Türkiye saati
const DAY = 864e5;
const dayKey = (t = Date.now()) => new Date(t + TR).toISOString().slice(0, 10);

function init({ client, commands, requirePerm, guildIdOf, ek, ADMIN_ONLY }) {
  const SITE = (process.env.PANEL_SITE || 'https://rinaejubbio.rinean01.workers.dev').replace(/\/$/, '');
  const API = (process.env.PANEL_API || SITE).replace(/\/$/, ''); // varsayılan: sitenin kendisi
  const SECRET = process.env.PANEL_SECRET || '';
  const enabled = Boolean(API && SECRET);
  if (!enabled) console.warn('[panel] PANEL_SECRET tanımlı değil, istatistik paneli kapalı.');

  let tokens = {}; // sunucuID -> panel linki anahtarı
  try { tokens = JSON.parse(fs.readFileSync(FILE, 'utf-8')) || {}; } catch { /* ilk çalıştırma */ }
  const saveTokens = () => {
    try { fs.writeFileSync(FILE, JSON.stringify(tokens)); } catch (e) { console.warn('[panel] kaydedilemedi:', e.message); }
  };

  // Sadece sayılar: kişi kimliği, mesaj içeriği yok
  function snapshot(gid) {
    const D = ek.D;
    const st = D.stats?.[gid]?.daily || {};
    const now = Date.now();
    const daily = [];
    const hours = Array(24).fill(0);
    for (let i = 29; i >= 0; i--) {
      const k = dayKey(now - i * DAY);
      const d = st[k] || {};
      daily.push({ d: k, m: d.m || 0, j: d.j || 0, r: d.r || 0, rep: d.rep || 0, mod: d.mod || 0 });
      if (i < 7 && Array.isArray(d.h)) d.h.forEach((c, h) => { hours[h] += c || 0; });
    }
    const g = client.guilds?.get(gid);
    return {
      v: 1,
      name: g?.name ?? 'Sunucu',
      members: g?.memberCount ?? g?.member_count ?? g?.members?.size ?? null,
      updated: now,
      daily,
      hours,
      pendingApps: (D.apps?.subs || []).filter((s) => s.gid === gid && s.status === 'pending').length,
      openReports: (D.reports?.list || []).filter((r) => r.gid === gid && r.status === 'open').length,
    };
  }

  async function post(body) {
    const r = await fetch(`${API}/api/push`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-secret': SECRET },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }

  const lastSig = {};
  async function pushGuild(gid, force = false) {
    const token = tokens[gid];
    if (!enabled || !token) return;
    const snap = snapshot(gid);
    const sig = JSON.stringify({ ...snap, updated: 0 });
    if (!force && lastSig[gid] === sig) return; // değişmediyse gönderme
    await post({ token, snap });
    lastSig[gid] = sig;
  }

  async function run() {
    for (const gid of Object.keys(tokens)) {
      try { await pushGuild(gid); } catch (e) { console.warn('[panel] gönderilemedi:', e.message); }
    }
  }
  client.on('ready', () => { setTimeout(run, 60_000).unref?.(); });
  setInterval(run, 30 * 60_000).unref?.();

  // !istatistik-link [yenile]
  commands['istatistik-link'] = async function (message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    if (!enabled) return message.reply('İstatistik paneli henüz kurulmamış (.env içinde PANEL_SECRET yok).');
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const renew = ['yenile', 'sifirla', 'sıfırla'].includes(String(args[0] || '').toLocaleLowerCase('tr-TR'));
    try {
      if (renew && tokens[gid]) { await post({ revoke: tokens[gid] }); delete tokens[gid]; }
      if (!tokens[gid]) { tokens[gid] = crypto.randomBytes(16).toString('hex'); saveTokens(); }
      await pushGuild(gid, true);
    } catch (e) {
      console.warn('[panel]', e.message);
      return message.reply('Panel sunucusuna ulaşamadım, birazdan tekrar dene.');
    }
    const link = `${SITE}/dashboard#${tokens[gid]}`;
    try {
      await message.author.send(`📊 Bu sunucunun istatistik paneli:\n${link}\n\nLinki sadece güvendiğin yetkililerle paylaş, linke sahip olan herkes istatistikleri görebilir. Yenilemek için: !istatistik-link yenile`);
      return message.reply('Panel linkini sana özel mesajla gönderdim 📊');
    } catch {
      return message.reply('Özel mesaj gönderemedim, DM\'lerin kapalı olabilir. Linki kanala yazmıyorum.');
    }
  };
  return { pushGuild };
}

module.exports = { init };