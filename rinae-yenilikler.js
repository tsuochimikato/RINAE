// RINAE - Yenilikler komutu (!yenilikler / !changelog / !updates)
// Otomatik duyuru: sunucu sahibi !yenilik-kanal #kanal ile bir kanal seçer. Bot yeniden başlayınca, o sunucunun
//   görmediği yeni kayıtlar (CHANGELOG) seçilen kanala tek bir embed olarak otomatik atılır. Kapatmak için: !yenilik-kanal kapat
// Sürüm: !surum sürümü gösterir. İki yolla verilir:
//   1) CHANGELOG kaydına  version: '1.2.0'  alanı ekle (bot açılışta en yeni sürümlü kaydı alır)
//   2) Bot yetkilisi !surum ayarla 1.2.0 yazar (elle değiştirir; sonraki sürümlü kayıt gelene kadar kalır)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'rinae-yenilikler.json');
const CODE_DIR = __dirname;          // otomatik algılama: bu klasördeki .js dosyalarının değişimi izlenir (botun modülleri yanındaysa)
const CMD_SNAPSHOT_MS = 15e3;        // komut listesi, diğer modüller de yüklendikten sonra alınır
const ANNOUNCE_DELAY_MS = 25e3;      // kanal duyuruları, bot sunuculara bağlandıktan sonra gönderilsin diye biraz beklenir
const DEFAULT_VERSION = '1.0.0';     // hiçbir kayıtta/komutla sürüm verilmediyse



// Yeni özellik eklediğinde EN ÜSTE yeni bir kayıt ekle (id yazmana gerek yok, aşağıda otomatik verilir:
// en alttaki 1, üstüne çıktıkça artar). Bot açılışta id'ye bakarak "yeni" olanları bulur.
const CHANGELOG = [

  {
    date: '24.10.2026', title: 'Otomatik yenilik duyurusu ve sürüm', version:'0.9',
    items: [
      'Sunucu sahibi `!yenilik-kanal #kanal` ile bir kanal seçtiğinde, bot güncellenince yeni eklenenler o kanala otomatik gönderilir.',
      '`!surum` ile botun sürümü görülür.',
    ],
  },

  {
    date: '24.10.2026', title: 'Global evlilik',
    items: [
      'Aile ilişkilerinin sunucudan sunucuya değişiklik göstermesine sebep olan hata düzeltildi.',
    ],
  },

  {
    date: '24.10.2026', title: 'Anlaşmalı Boşanma',
    items: [
      'İki taraf da ayrılmak ya da ebeveyn-çocuk bağını bitirmek istediğinde mağduriyeti önlemek için anlaşmalı boşanma eklendi.',
    ],
  },

  {
    date: '24.10.2026', title: 'Nafaka sistemi',
    items: [
      'Ekonomi ve aile sistemleri kısmi bağlandı.',
      'Ayrılık ve çocuk reddetmelerinde tek taraflı yapan kişinin nafaka ödemesi sağlandı.',
      '`!bosan`, `!disown` gibi komutlarda geçerli.',
    ],
  },

  {
    date: '24.10.2026', title: 'Leaderboard komutu',
    items: [
      'Mesaj ve ses liderlik sıralamasının ekonomi sıralaması ile ortak kullandığı komutlar düzeltildi.',
    ],
  },

  {
    date: '24.10.2026', title: 'Global ekonomi',
    items: [
      'Rinecy bakiyesi, hayvanat ve günlük seri artık tüm sunucularda ortak.',
      '`!gonder` için günlük 50.000 gönderim limiti eklendi.',
      '`!para-ver` ve `!para-al` sadece bot yetkililerine açıldı.',
    ],
  },

  {
    date: '24.10.2026', title: 'Ekonomi sistemi',
    items: [
      'Bakiye, avlanma ve günlük olarak bakiye kazanılabilecek bir sistem eklendi.',
      'Bakiyelerin tüm kullanıcılar arasında görünür bir kısıtlama olmadan aktarılabilmesi sağlandı.',
      'Yazıtura, Blackjack, slot gibi eğlence oyunları eklendi.',
    ],
  },

  {
    date: '24.10.2026', title: 'Aile güncellemeleri',
    items: [
      'Evlatlıktan reddetmek artık mümkün.',
      'Kullanıcıların aile ağacı artık soy ağacı görseliyle gösteriliyor.',
    ],
  },

  {
    date: '24.10.2026', title: 'Koruma sistemi',
    items: [
      'Sunucuya olası bot ve ani giriş saldırılarını önlemek için RAID Koruması eklendi.',
      'Olası toplu üye atılmaları, rol alımları vb. durumları önlemek için NUKE Koruması eklendi.',
    ],
  },

  {
    date: '20.10.2026', title: 'Güle güle sistemi',
    items: [
      '`!gulegule` ile butonlu panel: biri sunucudan ayrılınca seçilen kanala kişiyi etiketleyen samimi bir mesaj, kalan kişi sayısı ve rastgele gif gönderilir.',
      'Panelden kanal, açma/kapama, gif ve mesaj havuzu (ekleme/silme), sayı gösterimi ve test butonlarla yönetilir.',
      '`!help` menüsüne **👋 Güle Güle** sekmesi eklendi.',
    ],
  },

  {
    date: '20.10.2026', title: 'Çekiliş sistemi',
    items: [
      '`!cekilis` ile butonlu çekiliş paneli açılır: süre, kazanan sayısı ve kanal butonlarla seçilir, ödül ve rol şartı yazılarak girilir.',
      'Çekiliş mesajındaki **🎉 Katıl** butonuyla katılım, isteğe bağlı rol şartı.',
      'Panelden çekilişi erken bitirme, iptal etme ve yeniden çekme (reroll).',
      '`!help` menüsüne **🎁 Çekiliş** sekmesi eklendi.',
    ],
  },

  {
    date: '20.10.2026', title: 'Yenilikler komutu',
    items: ['`!yenilikler` (`!changelog`, `!updates`) ile son açılıştan beri eklenen özellikler görülür.'],
  },
  {
    date: '20.10.2026', title: 'Raid & Nuke koruması',
    items: [
      '`!koruma` paneli: kısa sürede çok kişi girerse sunucu kilitlenir ve girenler atılır/banlanır.',
      'Kanal/rol silme ve toplu ban takibi (aktör bulunursa ban, bulunamazsa alarm + kilit).',
      'Yetkililer için ban/kick hız limiti ve beyaz liste.',
    ],
  },
  {
    date: '20.10.2026', title: 'Genişletilmiş küfür listesi',
    items: [
      '`!kufur kaynak sync` ile dış kaynaklardan evrensel küfür listesi güncellenir.',
      '`!kufur kaynak liste|sil <kelime>` ile içe aktarılanlar yönetilir.',
    ],
  },
];

// id'leri sıraya göre otomatik ver: en alttaki 1, en üstteki en büyük
CHANGELOG.forEach((c, i) => { c.id = CHANGELOG.length - i; });

function init(ctx) {
  const { client, commands, HELP_PAGES, sendPanel, COLORS, postToChannel, guildIdOf, isSuper, isOwnerOf } = ctx;
  const trLower = (t) => String(t ?? '').toLocaleLowerCase('tr-TR');

  // ---------- Açılışta: son açılıştan beri neler eklendi? ----------
  // guilds: { [sunucuId]: { ch: duyuru kanalı, seen: o sunucuya duyurulan son id } }
  const st = { seen: 0, last: null, guilds: {}, version: null, versionSrc: 0, versionAt: 0 }; // seen: görülen son id, last: son güncelleme { at, ids }
  try { Object.assign(st, JSON.parse(fs.readFileSync(FILE, 'utf-8'))); } catch { /* ilk çalıştırma */ }
  if (!st.guilds || typeof st.guilds !== 'object') st.guilds = {};

  const latest = Math.max(0, ...CHANGELOG.map((c) => c.id));
  // json'daki "seen" listeden büyükse (eski numaralama / başka sürümden kalma) yeni kayıtlar hiç "yeni" sayılmazdı
  if (!(st.seen >= 0) || st.seen > latest) { console.warn(`[yenilikler] kayıtlı seen (${st.seen}) geçersiz, sıfırlandı (son id: ${latest})`); st.seen = 0; }
  const fresh = CHANGELOG.filter((c) => c.id > st.seen);
  if (fresh.length) st.last = { at: Date.now(), ids: fresh.map((c) => c.id) };
  console.log(`[yenilikler] ${CHANGELOG.length} kayıt, son id ${latest}, yeni: ${fresh.length ? fresh.map((c) => c.id).join(',') : 'yok'}`);
  st.seen = latest;

  // ---------- Sürüm ----------
  // En yeni "version" alanlı kayıt, daha önce uygulanmadıysa sürümü belirler. Elle !surum ayarla ile de değiştirilebilir.
  const vEntry = CHANGELOG.find((c) => c.version);
  if (vEntry && st.versionSrc !== vEntry.id) {
    st.version = String(vEntry.version).replace(/^v/i, '');
    st.versionSrc = vEntry.id;
    st.versionAt = Date.now();
  }
  const getVersion = () => st.version || DEFAULT_VERSION;

  function save() {
    try {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(st));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('rinae-yenilikler.json kaydedilemedi:', e.message); }
  }

  // ---------- Otomatik algılama 1: değişen / yeni / silinen modül dosyaları ----------
  function hashFiles() {
    const out = {};
    let names = [];
    try { names = fs.readdirSync(CODE_DIR); } catch { return out; }
    for (const f of names) {
      if (!f.endsWith('.js')) continue;
      try { out[f] = crypto.createHash('sha1').update(fs.readFileSync(path.join(CODE_DIR, f))).digest('hex').slice(0, 12); } catch { /* okunamadı */ }
    }
    return out;
  }
  const files = hashFiles();
  if (st.files) { // ilk çalıştırmada sadece referans alınır, "her şey yeni" denmez
    const changed = [], added = [];
    for (const [f, h] of Object.entries(files)) {
      if (!(f in st.files)) added.push(f);
      else if (st.files[f] !== h) changed.push(f);
    }
    const removed = Object.keys(st.files).filter((f) => !(f in files));
    if (changed.length || added.length || removed.length) st.autoFiles = { at: Date.now(), changed, added, removed };
  }
  st.files = files;
  save();

  // ---------- Otomatik algılama 2: yeni / kaldırılan komutlar ----------
  // Diğer modüller bu modülden sonra yüklenebileceği için liste biraz bekleyip alınır.
  const cmdTimer = setTimeout(() => {
    const now = Object.keys(commands).sort();
    if (st.cmds) {
      const prev = new Set(st.cmds), cur = new Set(now);
      const added = now.filter((c) => !prev.has(c));
      const removed = st.cmds.filter((c) => !cur.has(c));
      if (added.length || removed.length) st.autoCmds = { at: Date.now(), added, removed };
    }
    st.cmds = now;
    save();
    console.log(`[yenilikler] ${now.length} komut kaydedildi${st.autoCmds && st.autoCmds.added.length ? ` (yeni: ${st.autoCmds.added.length})` : ''}`);
  }, CMD_SNAPSHOT_MS);
  cmdTimer.unref?.();

  const fmt = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const toField = (c) => ({
    name: `🆕 ${c.title} • ${c.date}`,
    value: c.items.map((i) => `• ${i}`).join('\n').slice(0, 1000),
    inline: false,
  });
  // embed toplamı 6000 karakteri aşarsa mesaj hiç gitmez, o yüzden sığdığı kadar alınır
  const fitFields = (list, max = 10, budget = 4400) => {
    const out = []; let used = 0;
    for (const c of list.slice(0, max)) {
      const f = toField(c); const size = f.name.length + f.value.length;
      if (out.length && used + size > budget) break;
      out.push(f); used += size;
    }
    return out;
  };
  const listCmds = (arr, max = 12) => arr.slice(0, max).map((c) => `\`!${c}\``).join(' ') + (arr.length > max ? ` +${arr.length - max} daha` : '');
  // Dosya (modül) değişiklikleri geliştirici bilgisidir: sadece bot yetkililerine gösterilir (dev=true)
  function autoField(dev = false) {
    const lines = [];
    const c = st.autoCmds, f = st.autoFiles;
    if (c?.added?.length) lines.push(`➕ Yeni komutlar: ${listCmds(c.added)}`);
    if (c?.removed?.length) lines.push(`➖ Kaldırılan komutlar: ${listCmds(c.removed)}`);
    const fl = (arr) => arr.slice(0, 8).map((x) => `\`${x}\``).join(' ') + (arr.length > 8 ? ` +${arr.length - 8} daha` : '');
    if (dev) {
      if (f?.added?.length) lines.push(`📄 Yeni modül: ${fl(f.added)}`);
      if (f?.changed?.length) lines.push(`🔧 Güncellenen modül: ${fl(f.changed)}`);
      if (f?.removed?.length) lines.push(`🗑️ Kaldırılan modül: ${fl(f.removed)}`);
    }
    if (!lines.length) return null;
    const at = Math.max(c?.at || 0, dev ? (f?.at || 0) : 0);
    return { name: `🤖 Otomatik algılanan • ${fmt(at)}`, value: lines.join('\n').slice(0, 1000), inline: false };
  }
  const plainText = (list) => list.slice(0, 5).map((c) => `**${c.title}** • ${c.date}\n${c.items.map((i) => `• ${i}`).join('\n')}`).join('\n\n').slice(0, 1900);

  // ---------- Komut ----------
  async function yenilikler(message, args) {
    const dev = Boolean(isSuper?.(String(message.author?.id)));
    const all = ['hepsi', 'all'].includes(String(args[0] ?? '').toLowerCase());
    let list, desc;
    if (all) {
      list = [...CHANGELOG].sort((a, b) => b.id - a.id);
      desc = 'Tüm güncelleme geçmişi:';
    } else {
      const ids = new Set(st.last?.ids || []);
      list = CHANGELOG.filter((c) => ids.has(c.id)).sort((a, b) => b.id - a.id);
      if (list.length) {
        desc = `Son güncelleme: **${fmt(st.last.at)}**\nBot bu tarihte yeniden başladığında aşağıdakiler eklenmişti.`;
      } else {
        // son açılışta "yeni" kayıt bulunamadıysa boş dönme: en son eklenenleri göster
        list = [...CHANGELOG].sort((a, b) => b.id - a.id).slice(0, 3);
        desc = 'Son eklenen özellikler:';
      }
    }
    const payload = { embeds: [{
      title: all ? '📜 Güncelleme Geçmişi' : '🆕 Yenilikler',
      description: desc,
      color: COLORS?.ok ?? 0x57f287,
      fields: [...fitFields(list), ...(all ? [] : [autoField(dev)].filter(Boolean))],
      footer: { text: `${all ? 'Son 10 kayıt gösterilir' : 'Tüm geçmiş için: !yenilikler hepsi'} • Sürüm v${getVersion()}` },
    }] };
    const auto = all ? null : autoField(dev);
    try { return await sendPanel(message, payload); }
    catch (e) {
      console.warn('[yenilikler] embed gönderilemedi, düz yazıya düşüldü:', e?.message || e);
      return message.reply(`${all ? '📜 **Güncelleme Geçmişi**' : '🆕 **Yenilikler**'}\n${desc}\n\n${plainText(list)}${auto ? `\n\n**${auto.name}**\n${auto.value}` : ''}`);
    }
  }

  for (const n of ['yenilikler', 'changelog', 'updates', 'whatsnew']) {
    if (Object.hasOwn(commands, n)) console.warn(`[yenilikler] !${n} başka bir modülde de tanımlı, bu modül üzerine yazıyor`);
    commands[n] = yenilikler;
  }

  // ---------- Otomatik duyuru (sunucu sahibinin seçtiği kanala) ----------
  async function post(gid, channelId, payload) {
    if (typeof postToChannel === 'function') return postToChannel(gid, channelId, payload);
    await client.rest.request('POST', `/bot/guilds/${gid}/channels/${channelId}/messages`, JSON.parse(JSON.stringify(payload)));
    return true;
  }
  function announcePayload(list) {
    const shown = fitFields(list);
    const rest = list.length - shown.length;
    return { embeds: [{
      title: `🆕 RINAE v${getVersion()} • Yenilikler`,
      description: `Bot güncellendi, yeni eklenenler:${rest > 0 ? `\n(+${rest} güncelleme daha için \`!yenilikler hepsi\`)` : ''}`,
      color: COLORS?.ok ?? 0x57f287,
      fields: shown,
      footer: { text: 'RINAE • Otomatik yenilik duyurusu' },
    }] };
  }
  // Her sunucuya, o sunucunun görmediği kayıtlar tek mesajda gider. Gönderilemezse "seen" ilerlemez, bir sonraki açılışta tekrar denenir.
  async function announceAll() {
    for (const [gid, cfg] of Object.entries(st.guilds)) {
      if (!cfg?.ch) continue;
      const list = CHANGELOG.filter((c) => c.id > (cfg.seen ?? latest)).sort((a, b) => b.id - a.id);
      if (!list.length) continue;
      try {
        const ok = await post(gid, cfg.ch, announcePayload(list));
        if (ok) { cfg.seen = latest; save(); console.log(`[yenilikler] ${gid} sunucusuna ${list.length} yenilik duyuruldu`); }
        else console.warn(`[yenilikler] ${gid} duyurusu gönderilemedi (kanal/yetki?), sonraki açılışta tekrar denenecek`);
      } catch (e) { console.warn(`[yenilikler] ${gid} duyurusu hata verdi:`, e?.message || e); }
      await new Promise((r) => setTimeout(r, 1000)); // sunucular arası kısa bekleme
    }
  }
  if (Object.keys(st.guilds).length) {
    const annTimer = setTimeout(() => announceAll().catch((e) => console.warn('[yenilikler] duyuru hatası:', e?.message || e)), ANNOUNCE_DELAY_MS);
    annTimer.unref?.();
  }

  // Sunucu sahibi mi? (bot yetkilileri de olabilir). Sahip bilgisi botun sunucu nesnesinden okunur.
  function isOwner(message, gid) {
    // index.js'teki isOwnerOf: sunucu sahibi + RINAE sahibi + !tam-yetki verilenler
    try { if (typeof isOwnerOf === 'function' && isOwnerOf(message)) return true; } catch { /* aşağıdaki yedek yol denenir */ }
    const uid = String(message.author?.id);
    if (isSuper?.(uid)) return true;
    const g = client?.guilds?.get?.(gid) ?? client?.guilds?.cache?.get?.(gid);
    const o = g?.ownerId ?? g?.owner_id ?? g?.ownerID ?? g?.owner?.id ?? g?.owner?.user?.id;
    return o != null && String(o) === uid;
  }

  async function yenilikKanal(message, args) {
    const gid = String(guildIdOf?.(message) ?? message.guildId ?? '');
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const cfg = st.guilds[gid];
    if (!args[0]) {
      return message.reply(`${cfg?.ch ? `📣 Yenilik kanalı: <#${cfg.ch}>` : '📣 Yenilik kanalı ayarlı değil.'}\nAyarlamak için: \`!yenilik-kanal #kanal\` • Kapatmak için: \`!yenilik-kanal kapat\` (sadece sunucu sahibi)`);
    }
    if (!isOwner(message, gid)) return message.reply('Bu ayarı sadece sunucu sahibi yapabilir.');
    if (['kapat', 'sil', 'off', 'kapali', 'kapalı'].includes(trLower(args[0]))) {
      delete st.guilds[gid]; save();
      return message.reply('📣 Otomatik yenilik duyuruları kapatıldı.');
    }
    const id = String(args[0]).match(/\d{5,25}/)?.[0];
    if (!id) return message.reply('Kullanım: `!yenilik-kanal #kanal` ya da `!yenilik-kanal kapat`');
    const prev = st.guilds[gid];
    st.guilds[gid] = { ch: id, seen: latest }; // eski kayıtlar bu kanala yağmasın, sadece bundan sonrakiler gitsin
    let ok = false;
    try {
      ok = await post(gid, id, { embeds: [{ title: '✅ Yenilik kanalı ayarlandı', description: 'Bot güncellendiğinde yeni eklenenler otomatik olarak buraya gönderilecek.', color: COLORS?.ok ?? 0x57f287, footer: { text: `RINAE • Sürüm v${getVersion()}` } }] });
    } catch { ok = false; }
    if (!ok) {
      if (prev) st.guilds[gid] = prev; else delete st.guilds[gid];
      return message.reply('Bu kanala mesaj gönderemedim. Kanalı doğru yazdığından ve botun orada mesaj atma yetkisi olduğundan emin ol.');
    }
    save();
    return message.reply(`📣 Yenilik kanalı <#${id}> olarak ayarlandı.`);
  }

  async function surum(message, args) {
    const a0 = trLower(args[0]);
    if (!a0) return message.reply(`🤖 RINAE sürümü: **v${getVersion()}**${st.versionAt ? ` • ${fmt(st.versionAt)}` : ''}`);
    if (['ayarla', 'set'].includes(a0)) {
      if (!isSuper?.(String(message.author?.id))) return message.reply('Sürümü sadece bot yetkilileri değiştirebilir.');
      const v = String(args[1] ?? '').replace(/^v/i, '');
      if (!/^\d+(\.\d+){1,3}(-[\w.]+)?$/.test(v)) return message.reply('Kullanım: `!surum ayarla 1.2.0`');
      const old = getVersion();
      st.version = v; st.versionAt = Date.now(); save();
      return message.reply(`✅ Sürüm **v${old}** → **v${v}** olarak değiştirildi.`);
    }
    return message.reply('Kullanım: `!surum` • `!surum ayarla 1.2.0` (bot yetkilileri)');
  }

  for (const n of ['yenilik-kanal', 'yenilikkanal', 'yenilik-kanali', 'yenilikkanali', 'changelog-channel']) {
    if (Object.hasOwn(commands, n)) console.warn(`[yenilikler] !${n} başka bir modülde de tanımlı, bu modül üzerine yazıyor`);
    commands[n] = yenilikKanal;
  }
  for (const n of ['surum', 'sürüm', 'version', 'ver']) {
    if (Object.hasOwn(commands, n)) console.warn(`[yenilikler] !${n} başka bir modülde de tanımlı, bu modül üzerine yazıyor`);
    commands[n] = surum;
  }

  // ---------- Yardım menüsüne ekle ----------
  const oldHome = HELP_PAGES.home || (() => ({ fields: [] }));
  HELP_PAGES.home = () => {
    const p = oldHome();
    if (!p?.fields) return p;
    const g = p.fields.find((f) => f.name === '✨ Genel');
    if (g && !g.value.includes('!yenilikler')) g.value += '\n`!yenilikler` Son eklenen özellikler\n`!surum` Bot sürümü • `!yenilik-kanal #kanal` otomatik yenilik duyurusu';
    return p;
  };

  return { announceNow: announceAll };
}

module.exports = { init };