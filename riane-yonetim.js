require('./riane-yonetim.js');
'use strict';
// RINAE yönetim paneli (!yonetim): sadece butonlarla, bot ayarları (bakım/restart) YOK.
function init(ctx) {
  const { commands, ek, plus, FILTERS, setFilter, makeRow, sendPanel, respondUpdate, respondPrivate, requirePerm, COLORS, HELP_PAGES } = ctx;
  const D = ek.D;
  const cut = (v, n = 900) => String(v ?? '—').slice(0, n) || '—';
  const fmt = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const who = (id) => `<@${id}>\n\`${id}\``;
  const B = (page, arg, uid, label, style = 'Secondary') => ({ id: `ui:yp:${page}:${arg}:${uid}`, label, style });
  const rows = (defs) => {
    const out = [];
    for (let i = 0; i < defs.length; i += 5) out.push(makeRow(defs.slice(i, i + 5)));
    return out;
  };
  const textOf = (out) => out.filter((o) => typeof o === 'string').join('\n');
  const embedOf = (out) => out.find((o) => o && typeof o === 'object' && o.embeds?.length)?.embeds[0];
  const EV = { upcoming: '🟢 Yaklaşıyor', started: '🔴 Başladı' };

  // Komutları sahte bir mesajla çalıştırıp yanıtlarını yakalar
  async function run(name, args, interaction, userId, gid) {
    const out = [];
    const fake = {
      author: { id: String(userId), send: async () => {} },
      guildId: gid, guild: { id: gid },
      channelId: interaction.channelId ?? interaction.channel_id ?? interaction.channel?.id,
      content: '', __cmd: name, __permOverride: true,
      reply: async (x) => { out.push(x); },
      delete: async () => {},
    };
    try { await commands[name](fake, args); } catch (e) { out.push('Hata: ' + (e?.message || e)); }
    return out;
  }

  const pager = (list, id) => {
    const i = Math.max(0, list.findIndex((x) => x.id === id));
    return { cur: list[i], prev: list[(i - 1 + list.length) % list.length], next: list[(i + 1) % list.length], i };
  };

  // ---------- Butona basınca yapılan işlemler ----------
  async function perform(page, arg, interaction, uid, gid) {
    const [a, id] = arg.split('.');
    const go = (name, args) => run(name, args, interaction, uid, gid);
    const done = async (name, args, fallback = 'İşlem tamamlandı.', next = '') =>
      ({ arg: next, note: textOf(await go(name, args)) || fallback });

    if (page === 'filters' && a === 't' && FILTERS[id]) {
      const v = !FILTERS[id].get();
      await setFilter([id], v, uid);
      return { arg: '', note: `${FILTERS[id].label} filtresi ${v ? 'açıldı' : 'kapatıldı'}.` };
    }
    if (page === 'apps' && (a === 'ok' || a === 'red')) return done(a === 'ok' ? 'basvuru-onay' : 'basvuru-red', [id]);
    if (page === 'reports') {
      if (a === 'coz') return done('sikayet-coz', [id]);
      if (a === 'ret') return done('sikayet-ret', [id]);
      if (a === 'ata') return done('sikayet-ata', [id, uid], 'Şikayet sana atandı.', `v.${id}`);
    }
    if (page === 'events') {
      if (a === 'end') return done('event-end', [id], 'Etkinlik bitirildi.');
      if (a === 'iptal') return done('event-cancel', [id], 'Etkinlik iptal edildi.');
    }
    if (page === 'welcome') {
      if (a === 'on') return done('hosgeldin', ['ac']);
      if (a === 'off') return done('hosgeldin', ['kapat']);
      if (a === 'test') return done('hosgeldin', ['test'], 'Test mesajı gönderildi.');
    }
    if (page === 'motw' && a === 'ok') return done('haftanin-uyesi', ['onayla'], 'Haftanın üyesi duyuruldu.');
    return { arg, note: '' };
  }

  // ---------- Sayfalar ----------
  async function render(page, arg, gid, uid, note, interaction) {
    const home = B('home', '', uid, '🏠 Ana', 'Primary');
    const wrap = (embed, defs = [], withHome = true) => {
      const desc = [note ? `💬 ${note}` : null, embed.description].filter(Boolean).join('\n\n') || undefined;
      return {
        embeds: [{ ...embed, description: desc, color: embed.color ?? COLORS.main }],
        components: rows(withHome ? [...defs, home] : defs),
      };
    };
    const fromCmd = async (title, cmd, args, defs) => {
      const out = await run(cmd, args, interaction, uid, gid);
      const e = embedOf(out);
      return wrap(e ?? { title, description: textOf(out) || 'Gösterilecek veri yok.' }, defs);
    };
    const [a, rawId] = arg.split('.');

    if (page === 'close') return { embeds: [{ title: '🧭 Panel kapatıldı', description: 'Tekrar açmak için `!yonetim` yaz.', color: COLORS.main }], components: [] };

    if (page === 'filters') {
      return wrap({
        title: '🛡️ Filtreler',
        description: 'Butona basarak filtreyi aç/kapat.',
        fields: Object.values(FILTERS).map((f) => ({ name: f.label, value: f.get() ? '✅ Açık' : '❌ Kapalı', inline: true })),
      }, Object.entries(FILTERS).map(([k, f]) => B('filters', `t.${k}`, uid, `${f.label}: ${f.get() ? 'Kapat' : 'Aç'}`, f.get() ? 'Danger' : 'Success')));
    }

    if (page === 'apps') {
      const list = D.apps.subs.filter((s) => s.gid === gid && s.status === 'pending');
      if (!list.length) return wrap({ title: '📋 Başvurular', description: 'Bekleyen başvuru yok 🎉' });
      const { cur, prev, next, i } = pager(list, Number(rawId));
      return wrap({
        title: `📋 Başvuru #${cur.id} • ${cur.type} (${i + 1}/${list.length})`,
        fields: [
          { name: 'Başvuran', value: who(cur.userId), inline: true },
          { name: 'Tarih', value: fmt(cur.createdAt), inline: true },
          ...cur.answers.slice(0, 8).map((x, n) => ({ name: cut(`${n + 1}. ${x.q}`, 250), value: cut(x.a, 500), inline: false })),
        ],
        footer: { text: cur.answers.length > 8 ? 'Tüm cevaplar için: !basvuru-goster ' + cur.id : 'RINAE • Başvurular' },
      }, [
        B('apps', `ok.${cur.id}`, uid, '✅ Onayla', 'Success'), B('apps', `red.${cur.id}`, uid, '❌ Reddet', 'Danger'),
        B('apps', `v.${prev.id}`, uid, '◀'), B('apps', `v.${next.id}`, uid, '▶'),
      ]);
    }

    if (page === 'reports') {
      const list = D.reports.list.filter((r) => r.gid === gid && r.status === 'open');
      if (!list.length) return wrap({ title: '🚨 Şikayetler', description: 'Açık şikayet yok 🎉' });
      const { cur: r, prev, next, i } = pager(list, Number(rawId));
      const img = r.files.find((u) => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(u));
      return wrap({
        title: `🚨 Şikayet #${r.id} (${i + 1}/${list.length})`,
        description: cut(r.text || '(açıklama yok)', 1500),
        color: COLORS.bad,
        image: img ? { url: img } : undefined,
        fields: [
          { name: 'Şikayet eden', value: who(r.reporterId), inline: true },
          { name: 'İlgilenen', value: r.assignee ? who(r.assignee) : 'Atanmadı', inline: true },
          r.files.length ? { name: '📎 Ekler', value: cut(r.files.join('\n')), inline: false } : null,
        ].filter(Boolean),
      }, [
        B('reports', `coz.${r.id}`, uid, '✅ Çöz', 'Success'), B('reports', `ret.${r.id}`, uid, '❌ Reddet', 'Danger'),
        B('reports', `ata.${r.id}`, uid, '🙋 Üstlen', 'Primary'),
        B('reports', `v.${prev.id}`, uid, '◀'), B('reports', `v.${next.id}`, uid, '▶'),
      ]);
    }

    if (page === 'events') {
      const list = D.events.list.filter((e) => e.gid === gid && (e.status === 'upcoming' || e.status === 'started'));
      if (!list.length) return wrap({ title: '🎉 Etkinlikler', description: 'Yaklaşan etkinlik yok.\nOluşturmak için: `!event-create <başlık> | <tarih> | [ödül rolID]`' });
      const { cur: e, prev, next, i } = pager(list, Number(rawId));
      return wrap({
        title: `🎉 ${e.title} • #${e.id} (${i + 1}/${list.length})`,
        fields: [
          { name: '🕒 Zaman', value: fmt(e.startAt), inline: true },
          { name: 'Durum', value: EV[e.status], inline: true },
          { name: '🎁 Ödül', value: e.rewardRoleId ? `<@&${e.rewardRoleId}>` : 'Yok', inline: true },
          { name: `👥 Katılanlar (${e.participants.length})`, value: cut(e.participants.slice(0, 20).map((u) => `<@${u}>`).join(' ') || 'Henüz kimse yok'), inline: false },
        ],
      }, [
        B('events', `end.${e.id}`, uid, '🏁 Bitir', 'Success'), B('events', `iptal.${e.id}`, uid, '⛔ İptal', 'Danger'),
        B('events', `v.${prev.id}`, uid, '◀'), B('events', `v.${next.id}`, uid, '▶'),
      ]);
    }

    if (page === 'stats') {
      const map = { s: ['📊 Sunucu İstatistikleri', 'server-stats'], a: ['📈 Aktivite', 'activity'], w: ['🗓️ Haftalık Rapor', 'weekly-report'] };
      const [title, cmd] = map[a] ?? map.s;
      return fromCmd(title, cmd, [], [B('stats', 's', uid, '📊 Sunucu'), B('stats', 'a', uid, '📈 Aktivite'), B('stats', 'w', uid, '🗓️ Haftalık')]);
    }

    if (page === 'welcome') {
      const w = D.welcome;
      return wrap({
        title: '💖 Hoş Geldin Ayarları',
        fields: [
          { name: 'Durum', value: w.enabled ? '✅ Açık' : '❌ Kapalı', inline: true },
          { name: 'Kanal', value: w.channelId ? `<#${w.channelId}>` : 'Ayarlanmadı', inline: true },
          { name: 'İçerik', value: `${w.gifs.length} gif • ${w.messages.length} mesaj`, inline: true },
        ],
        footer: { text: 'Kanal/gif/mesaj düzenlemek için !hosgeldin komutu' },
      }, [B('welcome', 'on', uid, '✅ Aç', 'Success'), B('welcome', 'off', uid, '⛔ Kapat', 'Danger'), B('welcome', 'test', uid, '🧪 Test')]);
    }

    if (page === 'kayit') return fromCmd('📝 Kayıt Ayarları', 'kayit-ayar', ['goster'], [B('kayit', '', uid, '🔄 Yenile')]);
    if (page === 'sicil') return fromCmd('📋 Sicil', 'sicil', ['liste'], [B('sicil', '', uid, '🔄 Yenile')]);
    if (page === 'log') return fromCmd('📜 Son Loglar', 'log', [], [B('log', '', uid, '🔄 Yenile')]);
    if (page === 'motw') return fromCmd('⭐ Haftanın Üyesi', 'haftanin-uyesi', [], [B('motw', 'ok', uid, '✅ Birinciyi onayla', 'Success'), B('motw', '', uid, '🔄 Yenile')]);

    // Ana sayfa
    const pa = D.apps.subs.filter((s) => s.gid === gid && s.status === 'pending').length;
    const pr = D.reports.list.filter((r) => r.gid === gid && r.status === 'open').length;
    const pe = D.events.list.filter((e) => e.gid === gid && (e.status === 'upcoming' || e.status === 'started')).length;
    return wrap({
      title: '🧭 Yönetim Paneli',
      description: 'Aşağıdaki butonlarla sunucuyu yönetebilirsin.',
      fields: [
        { name: '📋 Bekleyen başvuru', value: String(pa), inline: true },
        { name: '🚨 Açık şikayet', value: String(pr), inline: true },
        { name: '🎉 Yaklaşan etkinlik', value: String(pe), inline: true },
      ],
      footer: { text: 'RINAE • Yönetim' },
    }, [
      B('filters', '', uid, '🛡️ Filtreler'), B('apps', '', uid, `📋 Başvuru (${pa})`), B('reports', '', uid, `🚨 Şikayet (${pr})`),
      B('events', '', uid, `🎉 Etkinlik (${pe})`), B('stats', 's', uid, '📊 İstatistik'),
      B('kayit', '', uid, '📝 Kayıt'), B('welcome', '', uid, '💖 Hoş geldin'), B('motw', '', uid, '⭐ Haftanın üyesi'),
      B('sicil', '', uid, '📋 Sicil'), B('log', '', uid, '📜 Log'), B('close', '', uid, '✖ Kapat', 'Danger'),
    ], false);
  }

  async function handleInteraction(interaction, { parts, userId, gid }) {
    try {
      const page = parts[2] || 'home', arg = parts[3] || '', owner = parts[4];
      if (!gid || !userId) return await respondPrivate(interaction, 'Bir sorun oluştu, `!yonetim` yazarak tekrar aç.');
      if (String(owner) !== String(userId)) return await respondPrivate(interaction, 'Bu paneli sen açmadın. Kendi paneli için `!yonetim` yaz.');
      if (!(plus.isSuper(userId) || (await ek.isAdminId(gid, userId)))) return await respondPrivate(interaction, 'Bu panel sadece sunucu sahibi ve yöneticiler içindir.');
      const uid = String(userId);
      const res = await perform(page, arg, interaction, uid, gid);
      return await respondUpdate(interaction, await render(page, res.arg, gid, uid, res.note, interaction));
    } catch (err) {
      console.error('yönetim paneli hatası:', err);
      try { await respondPrivate(interaction, 'Panelde bir sorun oluştu, tekrar dene.'); } catch { /* yoksay */ }
    }
  }

  commands.yonetim = async (message) => {
    if (!(await requirePerm(message, 'Administrator', 'Bu komut sadece sunucu sahibi/yöneticiler içindir.'))) return;
    const gid = message.guildId || message.guild?.id;
    const uid = String(message.author.id);
    return sendPanel(message, await render('home', '', gid, uid, '', message));
  };
  commands['yönetim'] = commands.yonetim;
  commands.ypanel = commands.yonetim;

  const old = HELP_PAGES.stats;
  HELP_PAGES.stats = () => {
    const p = old ? old() : { title: '📊 İstatistik & Yönetim', color: COLORS.main, fields: [] };
    p.fields.push({ name: '🧭 Yönetim paneli', value: '`!yonetim` butonlarla yönetim paneli (yöneticiler)', inline: false });
    return p;
  };

  return { handleInteraction };
}
module.exports = { init };