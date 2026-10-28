// RINAE - Küfür modülü
// 1) Sunucuya özel yasaklı ifade listesi (!kelime ...)
// 2) Botun kendi evrensel Türkçe küfür listesi (her sunucuda geçerli, !kufur evrensel ac|kapat ile sunucu bazlı kapatılabilir)
// 3) TDK (sozluk.gov.tr) ile doğrulama: !kufur tdk ara|tara|ekle|sil  (sadece bot yetkilileri)
// index.js ile aynı klasöre koy.
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'rinae-kufur.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tl = (t) => String(t ?? '').toLocaleLowerCase('tr-TR').replace(/\u0307/g, '');
const squash = (s) => s.replace(/(\p{L})\1+/gu, '$1'); // "siiiktir" -> "siktir", "yarrak" -> "yarak"

// Sonu * ile biten = o kökle başlayan her kelime (ek alanlar için). Diğerleri = kelimenin tamamı eşleşmeli.
// Bilerek temkinli tutuldu: "götürmek", "sıkıntı", "Amina" gibi masum kelimeler yakalanmasın diye.
// Eksik/fazla gördüğün olursa: !kufur tdk ekle <kelime>  veya sunucuya özel !kufur izin ekle <kelime>
const SEED = [
  'sik', 'sikim*', 'sikti*', 'sikey*', 'sikik*', 'sikiş*', 'amk', 'aq', 'oç', 'göt', 'götü', 'götün', 'götüne', 'götünü', 'götver*', 'gotver*',
  'piç', 'pic', 'orospu*', 'oruspu*', 'pezevenk*', 'yarak*', 'amcık*', 'amcik*', 'amına*', 'amını*',
  'şerefsiz*', 'serefsiz*', 'kahpe*', 'kaltak*', 'gavat*', 'ibne*', 'puşt*', 'pust*',
];

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

// Dış kaynaklar: type 'lines' = her satır bir kelime, 'wikt' = Wiktionary kategorisi
const SOURCES = [
  { name: 'LDNOOBW', type: 'lines', url: 'https://raw.githubusercontent.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words/master/tr' },
  { name: 'Wiktionary', type: 'wikt', url: 'https://en.wiktionary.org/w/api.php?action=query&list=categorymembers&cmtitle=Category:Turkish_vulgarities&cmlimit=500&format=json' },
];

async function getUrl(url, json) {
  if (typeof fetch !== 'function') return null; // Node 18+
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'RINAE-bot/1.0 (moderation)', Accept: json ? 'application/json' : 'text/plain' } });
    if (!r.ok) return null;
    return json ? await r.json() : await r.text();
  } catch { return null; } finally { clearTimeout(timer); }
}

// Kaynaktan ham kelime listesi çeker, null = ulaşılamadı
async function fetchSource(src) {
  if (src.type === 'lines') {
    const t = await getUrl(src.url, false);
    return t == null ? null : t.split(/\r?\n/);
  }
  const out = [];
  let url = src.url;
  for (let i = 0; i < 5; i++) { // en fazla 5 sayfa
    const j = await getUrl(url, true);
    if (!j) return i === 0 ? null : out;
    for (const m of j.query?.categorymembers || []) out.push(m.title);
    if (!j.continue?.cmcontinue) break;
    url = `${src.url}&cmcontinue=${encodeURIComponent(j.continue.cmcontinue)}`;
  }
  return out;
}

// Mesajı kelimelere ayırır: leet (s1kt1r), harf aralama (s i k t i r), uzatma (siiiktir) hilelerini çözer
function tokens(text) {
  let t = tl(text).replace(/[013457@$]/g, (c) => LEET[c]);
  t = t.replace(/(?<![\p{L}])\p{L}(?:[\s.\-_*]+\p{L}){3,}(?![\p{L}])/gu, (m) => m.replace(/[\s.\-_*]+/g, ''));
  return t.split(/[^\p{L}]+/u).filter(Boolean).map(squash);
}

function compile(list) {
  const exact = new Set(), prefix = [];
  for (const raw of list) {
    const pre = raw.endsWith('*');
    const w = squash(tl(raw.replace(/\*$/, '')));
    if (!w) continue;
    if (pre) prefix.push(w); else exact.add(w);
  }
  return { exact, prefix };
}

// TDK'da kelimeyi arar, "kaba/argo" etiketi veya küfür/hakaret anlamı var mı bakar. Ulaşılamazsa null.
async function tdkCheck(word) {
  if (typeof fetch !== 'function') return null; // Node 18+
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(`https://sozluk.gov.tr/gts?ara=${encodeURIComponent(word)}`, {
      signal: ctl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (RINAE bot)', Accept: 'application/json' },
    });
    if (!r.ok) return null;
    const res = await r.json();
    if (!Array.isArray(res)) return { found: false, flag: false, tags: [] };
    const key = tl(word);
    const entries = res.filter((e) => tl(String(e.madde || '').replace(/\s*\(.*?\)\s*$/, '')) === key);
    if (!entries.length) return { found: false, flag: false, tags: [] };
    const tags = new Set();
    let flag = false;
    for (const e of entries) {
      for (const a of e.anlamlarListe || []) {
        for (const o of a.ozelliklerListe || []) {
          const n = tl(o.tam_adi || o.kisa_adi || '');
          if (n) tags.add(n);
          if (/kaba|argo/.test(n)) flag = true;
        }
        if (/küfür|hakaret|sövme|sövgü/.test(tl(a.anlam || ''))) flag = true;
      }
    }
    return { found: true, flag, tags: [...tags].slice(0, 6) };
  } catch { return null; } finally { clearTimeout(timer); }
}

function init(ctx) {
  const {
    commands, HELP_PAGES, requirePerm, sendPanel, guildIdOf, ev, who, COLORS, actions, trLower,
    isSuper, legacy, legacyGuild, clearLegacy, ADMIN_ONLY,
  } = ctx;

  // ---------- Kalıcı veri ----------
  const data = { guilds: {}, added: [], tdk: {}, imported: [], blocked: [] };
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    for (const k of Object.keys(data)) if (j[k] !== undefined) data[k] = j[k];
  } catch { /* ilk çalıştırma */ }
  let timer = null, dirty = false;
  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try { fs.writeFileSync(FILE, JSON.stringify(data)); }
    catch (e) { dirty = true; console.warn('rinae-kufur.json kaydedilemedi:', e.message); }
  }
  function save() { dirty = true; if (!timer) { timer = setTimeout(flush, 1500); timer.unref?.(); } }

  const guild = (gid) => (data.guilds[gid] ||= { words: [], universal: true, safe: [] });

  // Eski global liste (ayarlar.json) ilk kullanımda log sunucusuna (yoksa komutun geldiği sunucuya) taşınır
  function claimLegacy(gid) {
    const old = legacy();
    if (!old.length) return;
    const g = guild(legacyGuild() || gid);
    for (const w of old) if (!g.words.includes(w)) g.words.push(w);
    clearLegacy();
    save();
  }
  function guildWords(gid) { claimLegacy(gid); return guild(gid).words; }
  function setGuildWords(gid, arr) { claimLegacy(gid); guild(gid).words = arr; save(); }

  // ---------- Evrensel liste ----------
  let U = null;
  const universal = () => (U ||= compile([...SEED, ...data.added, ...data.imported]));

  // Eşleşen evrensel kelimeyi ("evrensel:kelime") ya da null döner
  function matchUniversal(gid, content) {
    const g = guild(gid);
    if (g.universal === false) return null;
    const safe = new Set(g.safe);
    const L = universal();
    for (const tok of tokens(content)) {
      if (safe.has(tok)) continue;
      if (L.exact.has(tok) || L.prefix.some((p) => tok.startsWith(p))) return `evrensel:${tok}`;
    }
    return null;
  }

  // ---------- !kufur ----------
  const onoff = (v) => (['ac', 'aç', 'on', 'acik', 'açık'].includes(trLower(v)) ? true : ['kapat', 'off', 'kapali', 'kapalı'].includes(trLower(v)) ? false : null);
  let scanning = false;

  async function tdkCmd(message, args) {
    if (!isSuper(String(message.author?.id))) return message.reply('Bu alt komut sadece bot yetkililerine açık.');
    const act = trLower(args[1]);
    const word = tl(args[2] || '').trim();
    const okWord = /^\p{L}{2,40}\*?$/u.test(word);

    if (act === 'ara') {
      if (!okWord || word.endsWith('*')) return message.reply('Kullanım: !kufur tdk ara <kelime>');
      const r = await tdkCheck(word);
      if (r === null) return message.reply('TDK sözlüğüne şu an ulaşamadım, birazdan tekrar dene.');
      data.tdk[word] = { ...r, at: Date.now() };
      if (!r.found) { save(); return message.reply('TDK sözlüğünde bu madde yok, eklemedim.'); }
      if (!r.flag) { save(); return message.reply(`TDK'da var ama kaba/argo/küfür işareti yok, eklemedim. Yine de istersen: \`!kufur tdk ekle ${word}\``); }
      if (!data.added.includes(word)) { data.added.push(word); U = null; }
      save();
      await actions.log(ev('📚 Evrensel listeye eklendi (TDK)', COLORS.ok, [['Kelime', word], ['Etiket', r.tags.join(', ') || '—']]));
      return message.reply(`TDK'da kaba/argo/küfür olarak işaretli, evrensel listeye eklendi. (${r.tags.join(', ') || 'anlam metninden'})`);
    }
    if (act === 'ekle') {
      if (!okWord) return message.reply('Kullanım: !kufur tdk ekle <kelime>  (ek alan kökler için sonuna * koy: orospu*)');
      if (!data.added.includes(word)) { data.added.push(word); U = null; save(); }
      await actions.log(ev('📚 Evrensel listeye elle eklendi', COLORS.warn, [['Kelime', word], ['Yetkili', who(String(message.author.id))]]));
      return message.reply('Evrensel listeye eklendi.');
    }
    if (act === 'sil') {
      if (!data.added.includes(word)) return message.reply('Bu kelime sonradan eklenenler arasında yok (hazır liste koddan değişir).');
      data.added = data.added.filter((w) => w !== word); U = null; save();
      return message.reply('Evrensel listeden silindi.');
    }

        if (act === 'liste') {
      const flagged = Object.entries(data.tdk).filter(([, x]) => x.flag).map(([w]) => w);
      const seed = SEED.join(', ');
      const added = data.added.join(', ') || 'yok';
      const tdkList = flagged.join(', ') || 'henüz tarama yapılmadı (!kufur tdk tara)';
      return message.reply(
        `📚 Hazır liste (${SEED.length}): ${seed}\n\n➕ Sonradan eklenenler (${data.added.length}): ${added}\n\n✅ TDK'da kaba/argo işaretli bulunanlar (${flagged.length}): ${tdkList}`.slice(0, 1900)
      );
    }

    if (act === 'tara') {
      if (scanning) return message.reply('Tarama zaten sürüyor.');
      scanning = true;
      try {
        const roots = SEED.map((s) => s.replace(/\*$/, '')).filter((w) => /^\p{L}+$/u.test(w));
        await message.reply(`TDK ile ${roots.length} kök kontrol ediliyor, yaklaşık ${Math.ceil(roots.length * 0.4)} sn sürer...`);
        let flagged = 0, plain = 0, missing = 0, fail = 0;
        for (const w of roots) {
          const r = await tdkCheck(w);
          await sleep(300);
          if (r === null) { fail++; continue; }
          data.tdk[w] = { ...r, at: Date.now() };
          if (!r.found) missing++; else if (r.flag) flagged++; else plain++;
        }
        save();
        return message.reply(`TDK taraması bitti: ✅ ${flagged} kaba/argo/küfür olarak işaretli • ➖ ${plain} sözlükte var ama işaretsiz • ❔ ${missing} sözlükte yok (argo/yazım varyantı olabilir) • ⚠️ ${fail} sorgu başarısız.\nBu sonuç sadece bilgi içindir, listeyi değiştirmez.`);
      } finally { scanning = false; }
    }
    if (act === 'liste') {
  const added = data.added;
  const flagged = Object.entries(data.tdk).filter(([, v]) => v.flag).map(([w]) => w);
  const extra = flagged.filter((w) => !added.includes(w) && !added.includes(`${w}*`));
  const text =
    `📚 Evrensel listeye sonradan eklenenler (${added.length}):\n${added.length ? added.join(', ') : '—'}\n\n` +
    `🔎 TDK'da kaba/argo/küfür işaretli bulunan ama listeye eklenmemiş olanlar (${extra.length}):\n${extra.length ? extra.join(', ') : '—'}\n\n` +
    `Hazır (koddaki) liste ayrıca geçerli: ${SEED.length} kayıt.`;
  try {
    for (let i = 0; i < text.length; i += 1800) await message.author.send(text.slice(i, i + 1800));
    return message.reply('Listeyi sana özel mesajla gönderdim.');
  } catch {
    return message.reply('Özel mesaj gönderemedim, DM\'lerin kapalı olabilir. Listeyi kanala yazmıyorum.');
  }
}
    return message.reply('Kullanım: !kufur tdk <liste | ara <kelime> | tara | ekle <kelime> | sil <kelime>>');
  }

  commands.kufur = async function kufur(message, args) {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const sub = trLower(args[0]);
    if (sub === 'tdk') return tdkCmd(message, args);
    if (sub === 'kaynak') {
  if (!isSuper(String(message.author?.id))) return message.reply('Bu alt komut sadece bot yetkililerine açık.');
  const act = trLower(args[1]);

  if (act === 'sync') {
    await message.reply('Kaynaklar çekiliyor...');
    const known = new Set([...SEED.map((s) => s.replace(/\*$/, '')), ...data.added].map((w) => squash(tl(w))));
    const blocked = new Set(data.blocked);
    const found = new Set(data.imported);
    const lines = [];
    for (const src of SOURCES) {
      const raw = await fetchSource(src);
      if (raw === null) { lines.push(`⚠️ ${src.name}: ulaşılamadı`); continue; }
      let n = 0;
      for (const r of raw) {
        const w = squash(tl(r).trim());
        if (!/^\p{L}{3,30}$/u.test(w) || known.has(w) || blocked.has(w) || found.has(w)) continue;
        if (found.size >= 3000) break;
        found.add(w); n++;
      }
      lines.push(`✅ ${src.name}: ${raw.length} satır, ${n} yeni kelime`);
    }
    data.imported = [...found]; U = null; save();
    await actions.log(ev('📚 Küfür kaynakları eşitlendi', COLORS.ok, [['Toplam içe aktarılan', data.imported.length], ['Yetkili', who(String(message.author.id))]]));
    return message.reply(`${lines.join('\n')}\nToplam içe aktarılan: **${data.imported.length}**. Yanlış yakalayan olursa: \`!kufur kaynak sil <kelime>\``);
  }
  if (act === 'sil') {
    const w = squash(tl(args[2] || '').trim());
    if (!w) return message.reply('Kullanım: !kufur kaynak sil <kelime>');
    data.imported = data.imported.filter((x) => x !== w);
    if (!data.blocked.includes(w)) data.blocked.push(w); // sonraki sync'te geri gelmesin
    U = null; save();
    return message.reply('Listeden çıkarıldı, sonraki sync\'te de eklenmeyecek.');
  }
  if (act === 'liste') {
    if (!data.imported.length) return message.reply('İçe aktarılmış kelime yok. Önce: !kufur kaynak sync');
    try {
      await message.author.send(`İçe aktarılan (${data.imported.length}):\n${data.imported.join(', ')}`.slice(0, 1900));
      return message.reply('Listeyi sana özel mesajla gönderdim.');
    } catch { return message.reply('DM gönderemedim, DM\'lerin kapalı olabilir.'); }
  }
  return message.reply(`Kullanım: !kufur kaynak <sync|liste|sil <kelime>>\nŞu an ${data.imported.length} kelime içe aktarılmış.`);
}
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const g = guild(gid);
    claimLegacy(gid);

    if (sub === 'evrensel') {
      const v = onoff(args[1]);
      if (v === null) return message.reply('Kullanım: !kufur evrensel <ac|kapat>');
      g.universal = v; save();
      await actions.log(ev('🌐 Evrensel küfür listesi', v ? COLORS.ok : COLORS.warn, [['Durum', v ? 'Açık' : 'Kapalı'], ['Yetkili', who(String(message.author.id))]]));
      return message.reply(`Evrensel küfür listesi bu sunucuda ${v ? 'açıldı' : 'kapatıldı'}.`);
    }
    if (sub === 'izin') {
      const act = trLower(args[1]);
      const w = squash(tl(args[2] || '').trim());
      if (act === 'liste') return message.reply(g.safe.length ? `İzinli kelimeler: ${g.safe.join(', ')}` : 'İzinli kelime yok.');
      if (!/^\p{L}{2,40}$/u.test(w) || !['ekle', 'sil'].includes(act)) return message.reply('Kullanım: !kufur izin <ekle|sil|liste> <kelime>  (evrensel listenin yanlışlıkla yakaladığı kelimeyi bu sunucuda serbest bırakır)');
      if (g.safe.length >= 100 && act === 'ekle') return message.reply('En fazla 100 izinli kelime olabilir.');
      g.safe = act === 'ekle' ? [...new Set([...g.safe, w])] : g.safe.filter((x) => x !== w);
      save();
      return message.reply(`İzinli kelime listesi güncellendi (${g.safe.length} kelime).`);
    }

    const total = SEED.length + data.added.length + data.imported.length;
    const checked = Object.values(data.tdk).filter((x) => x.flag).length;
    return sendPanel(message, { embeds: [ev('🤬 Küfür Filtresi', COLORS.main, [
      ['🏠 Sunucuya özel', `${g.words.length} ifade\n\`!kelime ekle|sil|liste|temizle\``],
      ['🌐 Evrensel liste', `${g.universal ? '✅ Açık' : '❌ Kapalı'}\n${total} kayıt • ${checked} tanesi TDK'da kaba/argo işaretli`],
      ['✅ İzinli kelime', `${g.safe.length} (bu sunucu)`],
      ['Komutlar', '`!kufur evrensel ac|kapat` • `!kufur izin ekle|sil|liste <kelime>`\nBot yetkilileri: `!kufur tdk ara|tara|ekle|sil`', false],
    ])] });
  };
  commands['küfür'] = commands.kufur;

  // ---------- Yardım sayfası ----------
  const oldF = HELP_PAGES.filter;
  HELP_PAGES.filter = () => {
    const p = oldF ? oldF() : { title: '🛡️ Filtre Komutları', color: COLORS.main, fields: [] };
    p.fields.push({ name: '🌐 Evrensel küfür listesi', value: '`!kufur` durum • `!kufur evrensel ac|kapat` • `!kufur izin ekle|sil|liste <kelime>`\n`!kelime ...` artık sadece bu sunucunun listesini yönetir.', inline: false });
    return p;
  };

  return { guildWords, setGuildWords, matchUniversal, save, flush };
}

module.exports = { init };
