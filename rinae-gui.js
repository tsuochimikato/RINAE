// RINAE GUI katmanı: tüm yönetim komutlarını butonlu panellere taşır.
// index.js ile aynı klasöre koy. Kurulum için sohbetteki 6 küçük düzenlemeyi yap.
//
// Mantık: butona basınca mevcut komutlar arka planda çalıştırılır (sahte mesajla), sonuç panelde gösterilir.
// Yazı gereken yerde (kullanıcı, rol ID, metin) bot "şunu yaz" der, yazdığın mesaj otomatik silinir.
'use strict';

function init(ctx) {
  const {
    commands, actions, HELP_PAGES, ek, plus, FILTERS, CONFIG, REG, getRegRecords, makeRow, postToChannel,
    sendPanel, respondUpdate, respondPrivate, requirePerm, guildIdOf, COLORS, cleanId, trLower,
  } = ctx;

  const orig = { ...commands }; // GUI'nin arka planda çağıracağı orijinal komutlar
  const D = () => ek.D;
  const K = (gid, uid) => `${gid}:${uid}`;
  const sessions = new Map(); // yazı bekleyen oturumlar
  const flows = new Map();    // moderasyon akışı (hedef, süre)
  const chans = new Map();    // kullanıcının paneli açtığı kanal
  const TTL = 180_000;

  const cut = (v, n = 900) => String(v ?? '—').slice(0, n) || '—';
  const tokens = (t) => String(t ?? '').trim().split(/\s+/).filter(Boolean);
  const raw = (t) => String(t ?? '').trim();
  const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
  const chRef = (id) => (id ? `<#${id}>` : 'Ayarlı değil');
  const roleTxt = (id) => (id ? `<@&${id}>` : 'Tanımsız');
  const onoff = (v) => (v ? '✅ Açık' : '❌ Kapalı');
  const fmtTime = (ms) => new Date(ms).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const chanOf = (i) => i.channelId ?? i.channel_id ?? i.message?.channelId ?? i.message?.channel_id ?? i.channel?.id ?? null;

  // customId: ui:g:<sayfa>:<işlem>:<arg>:<panelSahibi>
  const mk = (s) => (page, label, style = 'Secondary', action = '', arg = '') => ({
    id: `ui:g:${page}:${action}:${arg}:${s.uid}`, label, style,
  });

  // ---------- Arka planda komut çalıştırma ----------
  async function run(cmd, args, s, { post = false } = {}) {
    const texts = [];
    const out = { text: '', payload: null };
    const fake = {
      id: 'gui', guildId: s.gid, guild: { id: s.gid }, channelId: s.channelId, content: '',
      author: { id: s.uid }, member: s.member, __cmd: cmd, __gui: true,
      delete: async () => {},
      reply: async (p) => {
        if (typeof p === 'string') texts.push(p);
        else if (p?.embeds?.length) { if (post) await postToChannel(s.gid, s.channelId, p); else out.payload = p; }
        else if (p?.content) texts.push(p.content);
        return true;
      },
    };
    const fn = orig[cmd];
    if (!fn) return { text: `Komut bulunamadı: ${cmd}`, payload: null };
    try {
      if (await ek.canRun(fake, cmd)) await fn(fake, args);
    } catch (e) {
      console.warn('[gui]', cmd, e?.message);
      texts.push('İşlem sırasında bir hata oluştu, konsola bak.');
    }
    out.text = texts.join('\n');
    return out;
  }

  // ---------- Sonuç tipleri ----------
  const go = (page, arg = '', note = '') => ({ page, arg, note });
  const ask = (prompt, handler, back = 'home', backArg = '') => ({ ask: { prompt, handler, back, backArg } });
  const res = (r, back, backArg = '') => (r.payload ? { view: r.payload, back, backArg } : go(back, backArg, r.text));
  const askText = (prompt, back, then, backArg = '') =>
    ask(prompt, async (t) => (raw(t) ? then(raw(t)) : { retry: 'Boş mesaj yazdın, tekrar dene.' }), back, backArg);
  const askUser = (prompt, back, then, backArg = '') =>
    ask(prompt, async (t) => {
      const u = tokens(t)[0];
      return u ? then(cleanId(u)) : { retry: 'Kullanıcı yazmadın, tekrar dene.' };
    }, back, backArg);
  const USER_P = 'Kullanıcıyı **etiketle** ya da **ID yaz**.';
  const ROLE_P = 'Rol **ID**\'sini yaz (ya da rolü etiketle). Kaldırmak için `yok` yaz.';

  // ---------- Sayfalar ----------
  const P = {};

  P.home = (s, a, b) => ({
    title: '🌸 RINAE Kontrol Paneli', color: COLORS.main,
    desc: 'Bir kategori seç. Her ayar butonlarla yapılır; yazı gerekirse bot sana ne yazacağını söyler.\nVazgeçmek için `iptal` yazabilirsin.',
    rows: [
      [b('mod', '🔨 Moderasyon'), b('filter', '🛡️ Filtreler'), b('roles', '🎭 Rol & Log'), b('reg', '📝 Kayıt'), b('welcome', '💖 Hoş Geldin')],
      [b('app', '📋 Başvuru'), b('report', '🚨 Şikayet'), b('event', '🎉 Etkinlik'), b('fun', '🎮 Eğlence'), b('stats', '📊 İstatistik')],
      [b('staff', '🛡️ Yetkililer'), b('motw', '⭐ Haftanın Üyesi'), b('perm', '🔐 Komut İzinleri'), plus.isSuper(s.uid) ? b('bot', '🤖 Bot') : null].filter(Boolean),
    ],
  });

  // ----- Moderasyon -----
  P.mod = (s, a, b) => ({
    title: '🔨 Moderasyon', color: COLORS.bad,
    desc: 'İşlemi seç, sonra kullanıcıyı **etiketle** ya da **ID yaz**.',
    rows: [
      [b('mod', '🔨 Ban', 'Danger', 'pick', 'ban'), b('mod', '👢 Kick', 'Danger', 'pick', 'kick'), b('mod', '🔇 Mute', 'Primary', 'pick', 'mute'),
        b('mod', '⏱️ Timeout', 'Primary', 'pick', 'timeout'), b('mod', '♻️ Unban', 'Success', 'pick', 'unban')],
      [b('mod', '🔊 Susturmayı Kaldır', 'Success', 'pick', 'unmute'), b('mod', '📋 Sicil Bak', 'Secondary', 'pick', 'sicil'),
        b('mod', '🧹 Sicil Sıfırla', 'Secondary', 'pick', 'sicil-sifirla'), b('mod', '📜 Sicil Listesi', 'Secondary', 'list')],
    ],
    back: 'home',
  });
  P.moddur = (s, a, b) => {
    const f = flows.get(K(s.gid, s.uid)) ?? {};
    const d = [['5 dk', 5], ['15 dk', 15], ['1 saat', 60], ['6 saat', 360], ['1 gün', 1440], ['7 gün', 10080], ['28 gün', 40320]];
    return {
      title: '⏱️ Süre Seç', color: COLORS.warn, desc: `Hedef: <@${f.target}>\nİşlem: **${f.act}**\nSüreyi seç:`,
      rows: chunk(d.map(([l, m]) => b('mod', l, 'Primary', 'dur', m)), 4), back: 'mod',
    };
  };
  P.modr = (s, a, b) => {
    const f = flows.get(K(s.gid, s.uid)) ?? {};
    return {
      title: '📝 Sebep', color: COLORS.warn,
      desc: `Hedef: <@${f.target}>\nİşlem: **${f.act}**${f.minutes ? ` • ${f.minutes} dk` : ''}\nSebep yazmak ister misin?`,
      rows: [[b('mod', '✍️ Sebep Yaz', 'Primary', 'reason'), b('mod', '⏩ Sebepsiz Uygula', 'Success', 'exec'), b('mod', '❌ İptal', 'Danger', 'abort')]],
    };
  };

  // ----- Filtreler -----
  P.filter = (s, a, b) => ({
    title: '🛡️ Filtre Paneli', color: COLORS.main, desc: 'Filtreleri aç/kapat ya da ayrıntılarına gir.',
    fields: Object.values(FILTERS).map((f) => [f.label, onoff(f.get())]),
    rows: [
      Object.entries(FILTERS).map(([k, f]) => b('filter', `${f.label}: ${f.get() ? 'Kapat' : 'Aç'}`, f.get() ? 'Danger' : 'Success', 'tog', k)),
      [b('words', '📝 Yasaklı İfadeler', 'Primary'), b('caps', '📢 Caps Ayarı', 'Primary')],
    ],
    back: 'home',
  });
  P.words = (s, a, b) => ({
    title: '📝 Yasaklı İfadeler', color: COLORS.bad,
    fields: [['Toplam ifade', CONFIG.bannedWords.length], ['Eşleşme modu', CONFIG.profanity.wholeWordOnly ? 'Tam' : 'İçeren'], ['Küfür filtresi', onoff(CONFIG.profanity.enabled)]],
    rows: [
      [b('words', '➕ İfade Ekle', 'Success', 'add'), b('words', '➖ İfade Sil', 'Danger', 'del'), b('words', '📜 Listele', 'Secondary', 'list')],
      [b('words', '🔁 Eşleşme Modunu Değiştir', 'Primary', 'mode'), b('words', '🧹 Hepsini Temizle', 'Danger', 'wipe')],
    ],
    back: 'filter',
  });
  P.caps = (s, a, b) => ({
    title: '📢 Caps Ayarı', color: COLORS.main, desc: 'Bağırarak yazılan mesajlar silinir. Hassasiyeti seç:',
    fields: [['Durum', onoff(D().capsEnabled)], ['Şu anki ayar', `En az ${D().caps.minLetters} harf • %${Math.round(D().caps.ratio * 100)} büyük harf`]],
    rows: [
      [b('caps', '🔒 Sıkı (6 • %60)', 'Danger', 'set', '6-60'), b('caps', '⚖️ Normal (8 • %70)', 'Primary', 'set', '8-70'), b('caps', '🌿 Esnek (12 • %85)', 'Success', 'set', '12-85')],
      [b('caps', D().capsEnabled ? '🔕 Filtreyi Kapat' : '🔔 Filtreyi Aç', D().capsEnabled ? 'Danger' : 'Success', 'tog')],
    ],
    back: 'filter',
  });

  // ----- Rol & Log -----
  P.roles = (s, a, b) => ({
    title: '🎭 Rol & Log', color: COLORS.ok,
    fields: [['📌 Log kanalı', chRef(CONFIG.logChannelId)]],
    rows: [
      [b('roles', '🎭 Rol Ver', 'Success', 'give'), b('roles', '🎭 Rol Al', 'Danger', 'take')],
      [b('roles', '📌 Bu Kanalı Log Yap', 'Primary', 'logset'), b('roles', '🚫 Logu Kapat', 'Danger', 'logoff'), b('roles', '📜 Son Loglar', 'Secondary', 'logs')],
    ],
    back: 'home',
  });

  // ----- Kayıt -----
  P.reg = (s, a, b) => ({
    title: '📝 Kayıt Ayarları', color: COLORS.main,
    fields: [
      ['✅ Kayıtlı rolü', roleTxt(REG.registeredRoleId)], ['🚫 Kayıtsız rolü', roleTxt(REG.unregisteredRoleId)],
      ['📍 Karşılama kanalı', chRef(REG.channelId)], ['Yaş aralığı', REG.ages.length], ['İlgi alanı', REG.interests.length],
      ['Kayıtlı üye', Object.values(getRegRecords()).filter((x) => x.guildId === s.gid).length],
    ],
    rows: [
      [b('reg', '✅ Kayıtlı Rolü', 'Primary', 'role', 'kayitli'), b('reg', '🚫 Kayıtsız Rolü', 'Primary', 'role', 'kayitsiz'),
        b('reg', '📍 Karşılama: Bu Kanal', 'Primary', 'chan'), b('reg', '🧪 Test', 'Secondary', 'test'), b('reg', '📣 Kayıt Paneli Koy', 'Success', 'panel')],
      [b('regg', '👤 Cinsiyet Rolleri'), b('rega', '🎂 Yaş Aralıkları'), b('regi', '🎭 İlgi Alanları'),
        b('reg', '🔎 Kayıt Bilgisi', 'Secondary', 'info'), b('reg', '🗑️ Kayıt Sil', 'Danger', 'del')],
    ],
    back: 'home',
  });
  P.regg = (s, a, b) => ({
    title: '👤 Cinsiyet Rolleri', color: COLORS.main, desc: 'Düzenlemek istediğine bas, sonra rol ID\'sini yaz.',
    fields: Object.values(REG.genders).map((g) => [g.label, roleTxt(g.roleId)]),
    rows: [Object.entries(REG.genders).map(([k, g]) => b('regg', g.label, 'Primary', 'set', k))], back: 'reg',
  });
  P.rega = (s, a, b) => ({
    title: '🎂 Yaş Aralıkları', color: COLORS.main, desc: 'Üst sıra: rol ayarla • Alt sıra: aralığı sil',
    fields: REG.ages.map((x) => [x.label, roleTxt(x.roleId)]),
    rows: [
      REG.ages.slice(0, 5).map((x, i) => b('rega', x.label, 'Primary', 'set', i)),
      REG.ages.slice(0, 5).map((x, i) => b('rega', `🗑️ ${x.label}`, 'Danger', 'del', i)),
      [b('rega', '➕ Aralık Ekle', 'Success', 'add')],
    ],
    back: 'reg',
  });
  P.regi = (s, a, b) => ({
    title: '🎭 İlgi Alanları', color: COLORS.main, desc: REG.interests.length ? 'Silmek için ilgili butona bas.' : 'Henüz ilgi alanı yok.',
    fields: REG.interests.map((x) => [x.label, roleTxt(x.roleId)]),
    rows: [...chunk(REG.interests.slice(0, 10).map((x, i) => b('regi', `🗑️ ${x.label}`, 'Danger', 'del', i)), 5), [b('regi', '➕ İlgi Alanı Ekle', 'Success', 'add')]],
    back: 'reg',
  });

  // ----- Hoş geldin -----
  P.welcome = (s, a, b) => {
    const w = D().welcome;
    return {
      title: '💖 Hoş Geldin Mesajı', color: COLORS.ok, desc: 'Kayıt tamamlanınca seçilen kanala tatlı bir karşılama mesajı atılır.',
      fields: [['Durum', onoff(w.enabled)], ['Kanal', chRef(w.channelId)], ['Gif', w.gifs.length], ['Mesaj', w.messages.length]],
      rows: [
        [b('welcome', w.enabled ? '🔕 Kapat' : '🔔 Aç', w.enabled ? 'Danger' : 'Success', 'tog'), b('welcome', '📍 Kanalı Bu Kanal Yap', 'Primary', 'chan'), b('welcome', '🧪 Test', 'Secondary', 'test')],
        [b('wgif', '🖼️ Gifler', 'Primary'), b('wmsg', '💬 Mesajlar', 'Primary')],
      ],
      back: 'home',
    };
  };
  P.wgif = (s, a, b) => {
    const g = D().welcome.gifs;
    return {
      title: '🖼️ Hoş Geldin Gifleri', color: COLORS.ok, desc: g.length ? g.slice(0, 10).map((u, i) => `**${i + 1}.** ${cut(u, 120)}`).join('\n') : 'Gif yok.',
      rows: [...chunk(g.slice(0, 10).map((u, i) => b('wgif', `🗑️ ${i + 1}`, 'Danger', 'del', i)), 5), [b('wgif', '➕ Gif Ekle', 'Success', 'add')]], back: 'welcome',
    };
  };
  P.wmsg = (s, a, b) => {
    const m = D().welcome.messages;
    return {
      title: '💬 Hoş Geldin Mesajları', color: COLORS.ok,
      desc: `${m.slice(0, 10).map((t, i) => `**${i + 1}.** ${cut(t, 140)}`).join('\n')}\n\n\`{user}\` ve \`{server}\` kullanabilirsin.`.slice(0, 3000),
      rows: [...chunk(m.slice(0, 10).map((t, i) => b('wmsg', `🗑️ ${i + 1}`, 'Danger', 'del', i)), 5), [b('wmsg', '➕ Mesaj Ekle', 'Success', 'add')]], back: 'welcome',
    };
  };

  // ----- Başvuru (ayarlar GUI, cevaplama yazıyla kalır) -----
  P.app = (s, a, b) => {
    const types = Object.entries(D().apps.types).filter(([, t]) => t.guildId === s.gid).slice(0, 10);
    const pending = D().apps.subs.filter((x) => x.gid === s.gid && x.status === 'pending').length;
    return {
      title: '📋 Başvuru Yönetimi', color: COLORS.main,
      desc: (types.length ? types.map(([n, t]) => `• \`${n}\` — ${t.title} (${t.questions.length} soru, ${t.open ? 'açık' : 'kapalı'})`).join('\n') : 'Henüz başvuru türü yok.') +
        '\n\nÜyeler başvuruyu `!basvuru <ad>` ile yapar, cevapları yazarak verir.',
      fields: [['📥 Bekleyen', pending]],
      rows: [
        ...chunk(types.map(([n]) => b('appt', `⚙️ ${n}`, 'Primary', '', n)), 5),
        [b('app', '➕ Yeni Başvuru', 'Success', 'new'), b('appl', '📥 Bekleyenler', 'Primary'), b('app', '📣 Başvuru Paneli Koy', 'Secondary', 'panel')],
      ],
      back: 'home',
    };
  };
  P.appt = (s, name, b) => {
    const t = D().apps.types[name];
    if (!t) return { title: '📋 Başvuru', color: COLORS.bad, desc: 'Bu başvuru türü bulunamadı.', rows: [], back: 'app' };
    return {
      title: `📋 ${t.title}`, color: COLORS.main,
      desc: t.questions.length ? t.questions.map((q, i) => `**${i + 1}.** ${cut(q, 150)}`).join('\n').slice(0, 2500) : 'Henüz soru yok.',
      fields: [['Ad', `\`${name}\``], ['Durum', onoff(t.open)], ['Değerlendirme kanalı', chRef(t.channelId)], ['Onay rolü', roleTxt(t.roleId)]],
      rows: [
        ...chunk(t.questions.slice(0, 10).map((q, i) => b('appt', `🗑️ ${i + 1}`, 'Danger', 'qd', `${name}~${i}`)), 5),
        [b('appt', '➕ Soru Ekle', 'Success', 'q+', name), b('appt', '📍 Kanal: Bu Kanal', 'Primary', 'chan', name), b('appt', '🎭 Onay Rolü', 'Primary', 'role', name),
          b('appt', t.open ? '🔒 Kapat' : '🔓 Aç', 'Secondary', 'tog', name), b('appt', '✏️ Başlık', 'Secondary', 'title', name)],
        [b('appt', '🗑️ Bu Başvuru Türünü Sil', 'Danger', 'del', name)],
      ],
      back: 'app',
    };
  };
  P.appl = (s, a, b) => {
    const list = D().apps.subs.filter((x) => x.gid === s.gid && x.status === 'pending').slice(-4).reverse();
    return {
      title: '📥 Bekleyen Başvurular', color: COLORS.warn, desc: list.length ? 'Onay ✅, red ❌, cevapları görmek 👁️' : 'Bekleyen başvuru yok 🎉',
      fields: list.map((x) => [`#${x.id} • ${x.type}`, `<@${x.userId}>`]),
      rows: list.map((x) => [b('appl', `✅ #${x.id}`, 'Success', 'ok', x.id), b('appl', `❌ #${x.id}`, 'Danger', 'no', x.id), b('appl', `👁️ #${x.id}`, 'Secondary', 'show', x.id)]),
      back: 'app',
    };
  };

  // ----- Şikayet -----
  P.report = (s, a, b) => ({
    title: '🚨 Şikayet Yönetimi', color: COLORS.bad, desc: 'Üyeler `!sikayet <açıklama>` yazar (ekran görüntüsü ekleyebilir).',
    fields: [['📍 Şikayet kanalı', chRef(D().reports.channelId)], ['🔔 Bildirim rolü', roleTxt(D().reports.pingRoleId)],
      ['🟡 Açık', D().reports.list.filter((r) => r.gid === s.gid && r.status === 'open').length]],
    rows: [[b('report', '📍 Kanalı Bu Kanal Yap', 'Primary', 'chan'), b('report', '🔔 Bildirim Rolü', 'Primary', 'role'), b('repl', '📂 Açık Şikayetler', 'Success')]],
    back: 'home',
  });
  P.repl = (s, a, b) => {
    const list = D().reports.list.filter((r) => r.gid === s.gid && r.status === 'open').slice(-4).reverse();
    return {
      title: '📂 Açık Şikayetler', color: COLORS.bad, desc: list.length ? '' : 'Açık şikayet yok 🎉',
      fields: list.map((r) => [`#${r.id}`, `<@${r.reporterId}>\n${cut(r.text, 80)}`]),
      rows: list.map((r) => [b('repl', `✅ Çöz #${r.id}`, 'Success', 'ok', r.id), b('repl', `❌ Ret #${r.id}`, 'Danger', 'no', r.id),
        b('repl', `👁️ #${r.id}`, 'Secondary', 'show', r.id), b('repl', `👤 Ata #${r.id}`, 'Primary', 'assign', r.id)]),
      back: 'report',
    };
  };

  // ----- Etkinlik -----
  P.event = (s, a, b) => {
    const list = D().events.list.filter((e) => e.gid === s.gid && (e.status === 'upcoming' || e.status === 'started')).slice(0, 3);
    return {
      title: '🎉 Etkinlik Yönetimi', color: COLORS.main, desc: list.length ? '' : 'Yaklaşan etkinlik yok.',
      fields: [['📍 Duyuru kanalı', chRef(D().events.channelId), false], ...list.map((e) => [`#${e.id} • ${e.title}`, `${fmtTime(e.startAt)}\n${e.participants.length} katılımcı`, false])],
      rows: [
        [b('event', '➕ Yeni Etkinlik', 'Success', 'new'), b('event', '📍 Duyuru Kanalı: Bu Kanal', 'Primary', 'chan')],
        ...list.map((e) => [b('event', `🏁 Bitir #${e.id}`, 'Success', 'end', e.id), b('event', `⛔ İptal #${e.id}`, 'Danger', 'cancel', e.id), b('event', `ℹ️ Bilgi #${e.id}`, 'Secondary', 'info', e.id)]),
      ],
      back: 'home',
    };
  };

  // ----- Eğlence -----
  P.fun = (s, a, b) => {
    const g = plus.G(s.gid);
    return {
      title: '🎮 Eğlence', color: COLORS.ok, desc: 'Sunucudaki eğlence oyunlarını buradan yönet.',
      fields: [
        ['🔤 Kelime Türetmece', g.word.channelId ? `${chRef(g.word.channelId)}\nSon kelime: **${g.word.current ?? '—'}**` : 'Kapalı'],
        ['🔢 Sayı Sayma', g.count.channelId ? `${chRef(g.count.channelId)}\nSıradaki: **${g.count.next}**` : 'Kapalı'],
        ['🎁 Oyun emojisi', plus.emoji()],
      ],
      rows: [[b('fw', '🔤 Kelime Türetmece', 'Primary'), b('fc', '🔢 Sayı Sayma', 'Primary'), b('fun', '🎁 Oyun Emojisi', 'Secondary', 'emoji')]],
      back: 'home',
    };
  };
  P.fw = (s, a, b) => {
    const W = plus.G(s.gid).word;
    return {
      title: '🔤 Kelime Türetmece', color: COLORS.ok, desc: 'Tek kelime yazılır, kelime öncekinin son harfiyle başlar, TDK sözlüğünde olmalı.',
      fields: [['Kanal', chRef(W.channelId)], ['Son kelime', W.current ?? '—'], ['Sıradaki harf', W.letter ? W.letter.toLocaleUpperCase('tr-TR') : '—'],
        ['Kabul edilen', W.accepted], ['Hata bildirimi', onoff(W.notice)]],
      rows: [
        [b('fw', '📍 Kanalı Bu Kanal Yap', 'Success', 'chan'), b('fw', '⏹️ Kapat', 'Danger', 'off'), b('fw', '🔄 Kelimeyi Atla', 'Primary', 'skip')],
        [b('fw', W.notice ? '🔕 Hata Bildirimini Kapat' : '🔔 Hata Bildirimini Aç', 'Secondary', 'notice'), b('fw', '♻️ Sıfırla', 'Danger', 'reset')],
      ],
      back: 'fun',
    };
  };
  P.fc = (s, a, b) => {
    const C = plus.G(s.gid).count;
    return {
      title: '🔢 Sayı Sayma', color: COLORS.ok, desc: 'Kanalda sırayla sayılır, yanlış mesajlar silinir.',
      fields: [['Kanal', chRef(C.channelId)], ['Sıradaki sayı', C.next], ['Rekor', C.record], ['Toplam doğru', C.total], ['Hata bildirimi', onoff(C.notice)]],
      rows: [
        [b('fc', '📍 Kanalı Bu Kanal Yap', 'Success', 'chan'), b('fc', '⏹️ Kapat', 'Danger', 'off'), b('fc', '♻️ Sıfırla', 'Danger', 'reset')],
        [b('fc', C.notice ? '🔕 Hata Bildirimini Kapat' : '🔔 Hata Bildirimini Aç', 'Secondary', 'notice')],
      ],
      back: 'fun',
    };
  };

  // ----- İstatistik / Yetkili / Haftanın üyesi / İzin / Bot -----
  P.stats = (s, a, b) => ({
    title: '📊 İstatistik', color: COLORS.main, desc: 'Bir rapor seç.',
    fields: [['📨 Otomatik haftalık rapor', chRef(D().weeklyReport.channelId)]],
    rows: [
      [b('stats', '📊 Sunucu İstatistikleri', 'Primary', 'srv'), b('stats', '📈 Aktivite', 'Primary', 'act'), b('stats', '📅 Haftalık Rapor', 'Primary', 'week')],
      [b('stats', '📨 Otomatik Rapor: Bu Kanal', 'Success', 'wkon'), b('stats', '🚫 Otomatik Raporu Kapat', 'Danger', 'wkoff')],
    ],
    back: 'home',
  });
  P.staff = (s, a, b) => ({
    title: '🛡️ Yetkili Performansı', color: COLORS.main, desc: 'Sadece komutla yapılan işlemler sayılır.',
    rows: [
      [b('staff', '🏆 Sıralama', 'Primary', 'top'), b('staff', '👤 Benimki', 'Primary', 'me'), b('staff', '🔎 Kişiye Bak', 'Secondary', 'find'), b('staff', '➕ Takibi Başlat', 'Success', 'add')],
    ],
    back: 'home',
  });
  P.motw = (s, a, b) => {
    const m = D().motw, w = D().weights;
    return {
      title: '⭐ Haftanın Üyesi', color: COLORS.ok,
      fields: [['📍 Duyuru kanalı', chRef(m.channelId)], ['🎭 Ödül rolü', roleTxt(m.roleId)], ['Son seçilen', m.lastUserId ? `<@${m.lastUserId}>` : '—'],
        ['⚖️ Puan', `mesaj×${w.msg} (limit ${w.msgCap}) • etkinlik×${w.event} • şikayet×${w.report}`, false]],
      rows: [
        [b('motw', '📋 Adaylar', 'Primary', 'cands'), b('motw', '✅ Birinciyi Onayla', 'Success', 'ok'), b('motw', '👤 Kişi Seç', 'Success', 'pick')],
        [b('motw', '📍 Kanal: Bu Kanal', 'Secondary', 'chan'), b('motw', '🎭 Ödül Rolü', 'Secondary', 'role'), b('motw', '⚖️ Ağırlık Ayarla', 'Secondary', 'weight')],
      ],
      back: 'home',
    };
  };
  P.perm = (s, a, b) => {
    const e = Object.entries(D().cmdRoles).slice(0, 20);
    return {
      title: '🔐 Komut İzinleri', color: COLORS.main,
      desc: 'Sunucu sahibi ve yöneticiler her komutu kullanır. Buradan başka rollere komut izni verebilirsin.',
      fields: e.length ? e.map(([k, r]) => [`!${k}`, r.length ? r.map((x) => `<@&${x}>`).join(' ') : 'Sadece yöneticiler']) : [['Durum', 'Özel izin yok']],
      rows: [
        [b('perm', '➕ Rol İzni Ver', 'Success', 'give'), b('perm', '➖ Rol İznini Al', 'Danger', 'take')],
        [b('perm', '🔒 Sadece Yönetici Yap', 'Primary', 'adm'), b('perm', '♻️ İzni Sıfırla', 'Secondary', 'reset')],
      ],
      back: 'home',
    };
  };
  P.bot = (s, a, b) => ({
    title: '🤖 Bot Yönetimi', color: COLORS.warn, desc: 'Sadece bot yetkililerine açık.',
    rows: [
      [b('bot', '🧑‍💻 Konsol', 'Primary', 'dev'), b('bot', '💾 Yedek Al', 'Success', 'backup'), b('bot', '🌐 Sunucular', 'Secondary', 'servers'), b('bot', '🤖 Bot İstatistik', 'Secondary', 'stats')],
      [b('bot', '🛠️ Bakım Aç', 'Danger', 'mon'), b('bot', '✅ Bakım Kapat', 'Success', 'moff'), b('bot', '♻️ Yeniden Başlat', 'Danger', 'restart'), b('bot', '👑 Tam Yetki', 'Secondary', 'super')],
    ],
    back: 'home',
  });

  // ----- Onay ekranı -----
  const CF = {
    'words~wipe': 'Tüm yasaklı ifadeler silinecek.', 'fw~reset': 'Kelime oyunu sıfırlanacak (kullanılan kelimeler silinir).',
    'fc~reset': 'Sayaç 1\'e dönecek (rekor korunur).', 'appt~del': 'Bu başvuru türü silinecek (geçmiş başvurular saklanır).', 'bot~restart': 'Bot yeniden başlatılacak.',
  };
  P.cf = (s, arg, b) => {
    const [pg, ac, ar = ''] = arg.split('~');
    return {
      title: '⚠️ Emin misin?', color: COLORS.warn, desc: CF[`${pg}~${ac}`] ?? 'Bu işlem geri alınamaz.',
      rows: [[b(pg, '✅ Evet', 'Danger', `${ac}!`, ar), b(pg, '❌ Vazgeç', 'Secondary', '', ar)]],
    };
  };

  // ---------- Panel oluşturma ----------
  function build(page, s, arg = '', note = '') {
    const b = mk(s);
    const def = (P[page] ?? P.home)(s, arg, b);
    const rows = (def.rows || []).filter((r) => r.length).slice(0, 4).map((r) => makeRow(r.slice(0, 5)));
    const nav = [def.back ? b(def.back, '◀ Geri', 'Secondary', '', def.backArg ?? '') : null, page !== 'home' ? b('home', '🏠 Ana Menü') : null].filter(Boolean);
    if (nav.length) rows.push(makeRow(nav));
    const desc = `${note ? `💬 ${cut(note, 600)}\n\n` : ''}${def.desc || ''}`.trim();
    return {
      embeds: [{
        title: def.title, color: def.color, description: desc || undefined,
        fields: (def.fields || []).map(([name, value, inline = true]) => ({ name, value: cut(value), inline })),
        footer: { text: 'RINAE • Kontrol Paneli' },
      }],
      components: rows,
    };
  }
  const viewPayload = (s, payload, back, backArg = '') => {
    const b = mk(s);
    return { embeds: payload.embeds, components: [makeRow([b(back || 'home', '◀ Geri', 'Secondary', '', backArg), b('home', '🏠 Ana Menü')])] };
  };
  const promptPanel = (s, prompt) => ({
    embeds: [{
      title: '✍️ Yazı Bekleniyor', color: COLORS.warn,
      description: `${prompt}\n\nBu kanala yaz, mesajın otomatik silinir. **3 dakika** içinde yazmazsan iptal olur.\nVazgeçmek için \`iptal\` yaz ya da butona bas.`,
    }],
    components: [makeRow([mk(s)('cancel', '❌ Vazgeç', 'Danger')])],
  });

  // ---------- Moderasyon uygulama ----------
  async function execMod(s, reason) {
    const k = K(s.gid, s.uid);
    const f = flows.get(k);
    if (!f) return go('mod', '', 'Oturum süresi doldu, tekrar dene.');
    const args = [f.target];
    if (f.minutes) args.push(String(f.minutes));
    args.push(...tokens(reason));
    const r = await run(f.act, args, s);
    flows.delete(k);
    return go('mod', '', r.text);
  }

  // ---------- Buton işlemleri ----------
  async function act(page, action, arg, s) {
    if (page === 'bot' && !plus.isSuper(s.uid)) return { priv: 'Bu bölüm sadece bot yetkililerine açık.' };
    if (page === 'cancel') {
      const k = K(s.gid, s.uid), ss = sessions.get(k);
      sessions.delete(k);
      return go(ss?.back ?? 'home', ss?.backArg ?? '', ss ? 'İptal edildi.' : '');
    }
    if (!action) return go(page, arg);

    const d = D();
    const R = (cmd, args, o) => run(cmd, args, s, o);
    const key = `${page}:${action}`;

    switch (key) {
      // --- Moderasyon ---
      case 'mod:pick':
        return askUser(arg === 'sicil-sifirla' ? `${USER_P} (Hepsini silmek için \`hepsi\` yaz.)` : USER_P, 'mod', async (u) => {
          flows.set(K(s.gid, s.uid), { act: arg, target: u });
          if (arg === 'ban' || arg === 'kick') return go('modr');
          if (arg === 'mute' || arg === 'timeout') return go('moddur');
          return res(await R(arg, [u]), 'mod');
        });
      case 'mod:dur': {
        const f = flows.get(K(s.gid, s.uid));
        if (!f) return go('mod', '', 'Oturum süresi doldu, tekrar dene.');
        f.minutes = Number(arg);
        return go('modr');
      }
      case 'mod:reason': return askText('Sebebi yaz.', 'mod', (t) => execMod(s, t));
      case 'mod:exec': return execMod(s, '');
      case 'mod:abort': flows.delete(K(s.gid, s.uid)); return go('mod', '', 'İptal edildi.');
      case 'mod:list': return res(await R('sicil', ['liste']), 'mod');

      // --- Filtreler ---
      case 'filter:tog': return go('filter', '', (await R('filtre', [arg, FILTERS[arg]?.get() ? 'kapat' : 'ac'])).text);
      case 'words:add':
        return askText('Eklenecek ifadeyi yaz (birden fazla için virgülle ayır).', 'words', async (t) => go('words', '', (await R('kelime', ['ekle', t])).text));
      case 'words:del':
        return askText('Silinecek ifadeyi yaz (birden fazla için virgülle ayır).', 'words', async (t) => go('words', '', (await R('kelime', ['sil', t])).text));
      case 'words:list': {
        const l = CONFIG.bannedWords;
        return { priv: l.length ? `Yasaklı ifadeler (${l.length}):\n${l.map((w, i) => `${i + 1}. ${w}`).join('\n')}`.slice(0, 1800) : 'Liste boş.' };
      }
      case 'words:mode': return go('words', '', (await R('kelime', ['mod', CONFIG.profanity.wholeWordOnly ? 'iceren' : 'tam'])).text);
      case 'words:wipe': return go('cf', 'words~wipe');
      case 'words:wipe!': return go('words', '', (await R('kelime', ['temizle'])).text);
      case 'caps:set': { const [mn, pc] = arg.split('-'); return go('caps', '', (await R('caps', ['ayar', mn, pc])).text); }
      case 'caps:tog': return go('caps', '', (await R('filtre', ['caps', d.capsEnabled ? 'kapat' : 'ac'])).text);

      // --- Rol & Log ---
      case 'roles:give':
      case 'roles:take': {
        const cmd = action === 'give' ? 'rol-ver' : 'rol-al';
        return askUser(USER_P, 'roles', (u) => ask('Şimdi **rol ID**\'sini yaz (ya da rolü etiketle).', async (t) => {
          const r = tokens(t)[0];
          return r ? go('roles', '', (await R(cmd, [u, r])).text) : { retry: 'Rol yazmadın, tekrar dene.' };
        }, 'roles'));
      }
      case 'roles:logset': return go('roles', '', (await R('log-kanal', [])).text);
      case 'roles:logoff': return go('roles', '', (await R('log-kapat', [])).text);
      case 'roles:logs': return res(await R('log', []), 'roles');

      // --- Kayıt ---
      case 'reg:role': return askText(ROLE_P, 'reg', async (t) => go('reg', '', (await R('kayit-ayar', [arg, tokens(t)[0]])).text));
      case 'reg:chan': return go('reg', '', (await R('kayit-ayar', ['kanal'])).text);
      case 'reg:test': return go('reg', '', (await R('kayit-ayar', ['test'])).text);
      case 'reg:panel': return go('reg', '', (await R('kayit-panel', [], { post: true })).text || 'Kayıt paneli bu kanala gönderildi.');
      case 'reg:info': return askUser(USER_P, 'reg', async (u) => res(await R('kayit-bilgi', [u]), 'reg'));
      case 'reg:del': return askUser(USER_P, 'reg', async (u) => go('reg', '', (await R('kayit-sil', [u])).text));
      case 'regg:set': return askText(ROLE_P, 'regg', async (t) => go('regg', '', (await R('kayit-ayar', ['cinsiyet', arg, tokens(t)[0]])).text));
      case 'rega:set': {
        const label = REG.ages[Number(arg)]?.label;
        if (!label) return go('rega', '', 'Aralık bulunamadı.');
        return askText(ROLE_P, 'rega', async (t) => go('rega', '', (await R('kayit-ayar', ['yas', ...label.split(' '), tokens(t)[0]])).text));
      }
      case 'rega:add': return askText('Yeni yaş aralığını yaz (örn: `13-17`).', 'rega', async (t) => go('rega', '', (await R('kayit-ayar', ['yas-ekle', t])).text));
      case 'rega:del': {
        const label = REG.ages[Number(arg)]?.label;
        return go('rega', '', label ? (await R('kayit-ayar', ['yas-sil', label])).text : 'Aralık bulunamadı.');
      }
      case 'regi:add':
        return askText('Şöyle yaz: `etiket rolID` (örn: `Oyuncu 123456789`).', 'regi', async (t) => go('regi', '', (await R('kayit-ayar', ['ilgi-ekle', ...tokens(t)])).text));
      case 'regi:del': {
        const label = REG.interests[Number(arg)]?.label;
        return go('regi', '', label ? (await R('kayit-ayar', ['ilgi-sil', label])).text : 'İlgi alanı bulunamadı.');
      }

      // --- Hoş geldin ---
      case 'welcome:tog': await R('hosgeldin', [d.welcome.enabled ? 'kapat' : 'ac']); return go('welcome');
      case 'welcome:chan': await R('hosgeldin', ['kanal']); return go('welcome', '', 'Hoş geldin kanalı bu kanal oldu.');
      case 'welcome:test': return go('welcome', '', (await R('hosgeldin', ['test'])).text);
      case 'wgif:add':
        return askText('Gif bağlantısını yaz (https://...).', 'wgif', async (t) => go('wgif', '', (await R('hosgeldin', ['gif-ekle', t])).text));
      case 'wgif:del': return go('wgif', '', (await R('hosgeldin', ['gif-sil', String(Number(arg) + 1)])).text);
      case 'wmsg:add':
        return askText('Mesajı yaz. `{user}` etiket, `{server}` sunucu adı olur.', 'wmsg', async (t) => go('wmsg', '', (await R('hosgeldin', ['mesaj-ekle', t])).text));
      case 'wmsg:del': return go('wmsg', '', (await R('hosgeldin', ['mesaj-sil', String(Number(arg) + 1)])).text);

      // --- Başvuru ---
      case 'app:new':
        return askText('Şöyle yaz: `ad Başlık` (örn: `partner Partner Başvurusu`). Ad tek kelime olmalı.', 'app', async (t) => {
          const name = trLower(tokens(t)[0]).replace(/[^\p{L}\p{N}_-]/gu, '');
          const r = await R('basvuru-olustur', tokens(t));
          return d.apps.types[name] ? go('appt', name, 'Oluşturuldu! Şimdi soruları ekle.') : go('app', '', r.text);
        });
      case 'app:panel': return go('app', '', (await R('basvuru-panel', [], { post: true })).text || 'Panel bu kanala gönderildi.');
      case 'appt:q+':
        return askText('Soruyu yaz.', 'appt', async (t) => {
          const before = d.apps.types[arg]?.questions.length ?? 0;
          const r = await R('basvuru-soru', [arg, 'ekle', t]);
          return go('appt', arg, (d.apps.types[arg]?.questions.length ?? 0) > before ? 'Soru eklendi.' : r.text);
        }, arg);
      case 'appt:qd': { const [n, i] = arg.split('~'); await R('basvuru-soru', [n, 'sil', String(Number(i) + 1)]); return go('appt', n, 'Soru silindi.'); }
      case 'appt:chan': return go('appt', arg, (await R('basvuru-ayar', [arg, 'kanal'])).text);
      case 'appt:role': return askText(ROLE_P, 'appt', async (t) => go('appt', arg, (await R('basvuru-ayar', [arg, 'rol', tokens(t)[0]])).text), arg);
      case 'appt:tog': return go('appt', arg, (await R('basvuru-ayar', [arg, 'durum', d.apps.types[arg]?.open ? 'kapat' : 'ac'])).text);
      case 'appt:title': return askText('Yeni başlığı yaz.', 'appt', async (t) => go('appt', arg, (await R('basvuru-ayar', [arg, 'baslik', t])).text), arg);
      case 'appt:del': return go('cf', `appt~del~${arg}`);
      case 'appt:del!': await R('basvuru-sil', [arg]); return go('app', '', 'Başvuru türü silindi.');
      case 'appl:ok': return go('appl', '', (await R('basvuru-onay', [arg])).text);
      case 'appl:no': return go('appl', '', (await R('basvuru-red', [arg])).text);
      case 'appl:show': return res(await R('basvuru-goster', [arg]), 'appl');

      // --- Şikayet ---
      case 'report:chan': return go('report', '', (await R('sikayet-ayar', ['kanal'])).text);
      case 'report:role': return askText(ROLE_P, 'report', async (t) => go('report', '', (await R('sikayet-ayar', ['rol', tokens(t)[0]])).text));
      case 'repl:ok': return go('repl', '', (await R('sikayet-coz', [arg])).text);
      case 'repl:no': return go('repl', '', (await R('sikayet-ret', [arg])).text);
      case 'repl:show': return res(await R('sikayet-goster', [arg]), 'repl');
      case 'repl:assign': return askUser(`${USER_P} (Şikayet #${arg} ona atanacak.)`, 'repl', async (u) => go('repl', '', (await R('sikayet-ata', [arg, u])).text));

      // --- Etkinlik ---
      case 'event:new':
        return askText('Etkinlik **başlığını** yaz.', 'event', (title) => {
          const clean = title.replace(/\|/g, ' ').slice(0, 80);
          return ask('**Ödül rolü** ID\'sini yaz (ödül yoksa `yok`).', async (rw) => ask(
            '**Tarih/saati** yaz. Örn: `yarın 21:00` ya da `25.12.2026 21:00`',
            async (when) => {
              const before = d.events.nextId;
              const r = await R('event-create', [clean, '|', raw(when), '|', tokens(rw)[0] || 'yok']);
              return d.events.nextId === before ? { retry: r.text || 'Tarihi anlayamadım, tekrar yaz.' } : go('event', '', '🎉 Etkinlik oluşturuldu!');
            }, 'event'), 'event');
        });
      case 'event:chan': return go('event', '', (await R('event-kanal', [])).text);
      case 'event:end': return go('event', '', (await R('event-end', [arg])).text);
      case 'event:cancel': return go('event', '', (await R('event-cancel', [arg])).text);
      case 'event:info': return res(await R('event-info', [arg]), 'event');

      // --- Eğlence ---
      case 'fun:emoji':
        return askText('Yeni oyun emojisini yaz (sadece bot sahibi değiştirebilir).', 'fun', async (t) => go('fun', '', (await R('oyun-emoji', [tokens(t)[0]])).text));
      case 'fw:chan': case 'fc:chan': return go(page, '', (await R(page === 'fw' ? 'kelime-oyunu' : 'sayi-oyunu', ['kanal'])).text || 'Oyun bu kanalda başladı.');
      case 'fw:off': case 'fc:off': return go(page, '', (await R(page === 'fw' ? 'kelime-oyunu' : 'sayi-oyunu', ['kapat'])).text);
      case 'fw:skip': return go('fw', '', (await R('kelime-oyunu', ['atla'])).text);
      case 'fw:notice': return go('fw', '', (await R('kelime-oyunu', ['uyari', plus.G(s.gid).word.notice ? 'kapat' : 'ac'])).text);
      case 'fc:notice': return go('fc', '', (await R('sayi-oyunu', ['uyari', plus.G(s.gid).count.notice ? 'kapat' : 'ac'])).text);
      case 'fw:reset': return go('cf', 'fw~reset');
      case 'fc:reset': return go('cf', 'fc~reset');
      case 'fw:reset!': return go('fw', '', (await R('kelime-oyunu', ['sifirla'])).text);
      case 'fc:reset!': return go('fc', '', (await R('sayi-oyunu', ['sifirla'])).text);

      // --- İstatistik / Yetkili / Haftanın üyesi ---
      case 'stats:srv': return res(await R('server-stats', []), 'stats');
      case 'stats:act': return res(await R('activity', []), 'stats');
      case 'stats:week': return res(await R('weekly-report', []), 'stats');
      case 'stats:wkon': return go('stats', '', (await R('weekly-report', ['kanal'])).text);
      case 'stats:wkoff': return go('stats', '', (await R('weekly-report', ['kapat'])).text);
      case 'staff:top': return res(await R('yetkili-liste', []), 'staff');
      case 'staff:me': return res(await R('yetkili-performans', []), 'staff');
      case 'staff:find': return askUser(USER_P, 'staff', async (u) => res(await R('yetkili-performans', [u]), 'staff'));
      case 'staff:add': return askUser(USER_P, 'staff', async (u) => go('staff', '', (await R('yetkili-ekle', [u])).text));
      case 'motw:cands': return res(await R('haftanin-uyesi', []), 'motw');
      case 'motw:ok': return go('motw', '', (await R('haftanin-uyesi', ['onayla'])).text || 'Haftanın üyesi duyuruldu.');
      case 'motw:pick': return askUser(USER_P, 'motw', async (u) => go('motw', '', (await R('haftanin-uyesi', ['onayla', u])).text || 'Haftanın üyesi duyuruldu.'));
      case 'motw:chan': return go('motw', '', (await R('haftanin-uyesi', ['kanal'])).text);
      case 'motw:role': return askText(ROLE_P, 'motw', async (t) => go('motw', '', (await R('haftanin-uyesi', ['rol', tokens(t)[0]])).text));
      case 'motw:weight':
        return askText('Şöyle yaz: `tür sayı` (tür: mesaj, etkinlik, rapor, limit). Örn: `etkinlik 40`', 'motw', async (t) => go('motw', '', (await R('haftanin-uyesi', ['agirlik', ...tokens(t)])).text));

      // --- Komut izinleri ---
      case 'perm:give': return askText('Şöyle yaz: `komut rolID` (örn: `ban 123456789`).', 'perm', async (t) => go('perm', '', (await R('komut-izin', ['ver', ...tokens(t)])).text));
      case 'perm:take': return askText('Şöyle yaz: `komut rolID`.', 'perm', async (t) => go('perm', '', (await R('komut-izin', ['al', ...tokens(t)])).text));
      case 'perm:adm': return askText('Komut adını yaz (örn: `ban`).', 'perm', async (t) => go('perm', '', (await R('komut-izin', ['yonetici', tokens(t)[0]])).text));
      case 'perm:reset': return askText('Komut adını yaz (örn: `ban`).', 'perm', async (t) => go('perm', '', (await R('komut-izin', ['sifirla', tokens(t)[0]])).text));

      // --- Bot ---
      case 'bot:dev': return res(await R('dev', []), 'bot');
      case 'bot:backup': return go('bot', '', (await R('dev', ['yedek'])).text);
      case 'bot:servers': return res(await R('sunucular', []), 'bot');
      case 'bot:stats': return res(await R('bot-stats', []), 'bot');
      case 'bot:mon': return askText('Şöyle yaz: `dakika sebep` (örn: `30 güncelleme`). Süresiz için sadece sebep yaz.', 'bot', async (t) => go('bot', '', (await R('bakim', ['ac', ...tokens(t)])).text));
      case 'bot:moff': return go('bot', '', (await R('bakim', ['kapat'])).text);
      case 'bot:restart': return go('cf', 'bot~restart');
      case 'bot:restart!': setTimeout(() => { run('yeniden-baslat', [], s).catch(() => {}); }, 1500); return go('bot', '', '♻️ Yeniden başlatılıyor...');
      case 'bot:super': return askText('Şöyle yaz: `ver @kişi`, `al @kişi` ya da `liste`.', 'bot', async (t) => go('bot', '', (await R('tam-yetki', tokens(t))).text));
      default: return go(page, arg);
    }
  }

  // ---------- Sonuçları ekrana verme ----------
  const setSession = (s, a) => sessions.set(K(s.gid, s.uid), { channelId: s.channelId, handler: a.handler, back: a.back, backArg: a.backArg, exp: Date.now() + TTL, s });

  async function deliver(interaction, s, r) {
    if (r.priv) return respondPrivate(interaction, r.priv);
    if (r.ask) { setSession(s, r.ask); return respondUpdate(interaction, promptPanel(s, r.ask.prompt)); }
    if (r.view) return respondUpdate(interaction, viewPayload(s, r.view, r.back, r.backArg));
    return respondUpdate(interaction, build(r.page, s, r.arg, r.note));
  }
  async function postResult(s, r) {
    const to = (p) => postToChannel(s.gid, s.channelId, p);
    if (r.ask) { setSession(s, r.ask); return to(promptPanel(s, r.ask.prompt)); }
    if (r.view) return to(viewPayload(s, r.view, r.back, r.backArg));
    if (r.priv) return to({ content: r.priv });
    return to(build(r.page, s, r.arg, r.note));
  }

  async function allowed(s) {
    return plus.isSuper(s.uid) || (await ek.isAdminId(s.gid, s.uid));
  }

  // Buton tıklaması (index.js interactionCreate içinden çağrılır)
  async function handleInteraction(interaction, { parts, userId, gid }) {
    const [, , page = 'home', action = '', arg = '', owner] = parts;
    const uid = String(userId ?? '');
    if (!gid || !uid) return respondPrivate(interaction, 'Bir sorun oluştu, `!panel` yazıp tekrar dene.');
    if (owner && owner !== uid) return respondPrivate(interaction, 'Bu paneli sen açmadın. Kendi panelin için `!panel` yaz.');
    const s = { gid: String(gid), uid, channelId: chanOf(interaction) || chans.get(K(gid, uid)) || null, member: interaction.member };
    if (s.channelId) chans.set(K(gid, uid), s.channelId);
    if (!(await allowed(s))) return respondPrivate(interaction, 'Bu paneli sadece sunucu sahibi ve yöneticiler kullanabilir.');
    let r;
    try { r = await act(page, action, arg, s); }
    catch (e) { console.error('[gui] hata:', e); return respondPrivate(interaction, 'Bir hata oluştu, konsola bak.'); }
    return deliver(interaction, s, r);
  }

  // Yazı bekleyen oturumlar için mesaj yakalama (index.js messageCreate başında çağrılır)
  async function onMessage(message) {
    const gid = guildIdOf(message);
    if (!gid || !message.author?.id) return false;
    const key = K(gid, String(message.author.id));
    const ss = sessions.get(key);
    if (!ss) return false;
    if (Date.now() > ss.exp) { sessions.delete(key); return false; }
    if (ss.channelId && message.channelId !== ss.channelId) return false;
    if (message.content.startsWith(CONFIG.prefix)) return false;
    ss.s.channelId ||= message.channelId;
    const text = message.content.trim();
    await actions.deleteMessage(message);
    sessions.delete(key);
    if (['iptal', 'cancel', 'vazgeç', 'vazgec'].includes(trLower(text))) {
      await postResult(ss.s, go(ss.back, ss.backArg, 'İptal edildi.'));
      return true;
    }
    let r;
    try { r = await ss.handler(text, message); }
    catch (e) { console.error('[gui] yazı işleme hatası:', e); r = go(ss.back, ss.backArg, 'Bir hata oluştu, konsola bak.'); }
    if (r?.retry) {
      sessions.set(key, { ...ss, exp: Date.now() + TTL });
      await postToChannel(gid, ss.s.channelId, { content: `⚠️ ${r.retry}` });
      return true;
    }
    await postResult(ss.s, r);
    return true;
  }

  // ---------- Panel açma komutları ----------
  async function open(message, page = 'home') {
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    if (!(await requirePerm(message, 'Administrator', 'Bu panel sadece sunucu sahibi ve yöneticiler içindir.'))) return;
    const s = { gid, uid: String(message.author.id), channelId: message.channelId, member: message.member };
    chans.set(K(gid, s.uid), s.channelId);
    return sendPanel(message, build(page, s));
  }

  // Argümansız yazılan eski komutlar artık doğrudan ilgili paneli açar
  const OPEN = {
    filtre: 'filter', hosgeldin: 'welcome', 'kayit-ayar': 'reg', kelime: 'words', 'kelime-oyunu': 'fw', 'sayi-oyunu': 'fc',
    'komut-izin': 'perm', 'sikayet-ayar': 'report', 'basvuru-olustur': 'app', 'haftanin-uyesi': 'motw', caps: 'caps', 'sunucu-ayar': 'fun',
  };
  for (const [name, page] of Object.entries(OPEN)) {
    const f = orig[name];
    if (f) commands[name] = async (message, args) => (args.length ? f(message, args) : open(message, page));
  }
  commands.filtreler = commands.filtre;
  commands['kayıt-ayar'] = commands['kayit-ayar'];

  Object.assign(commands, {
    panel: (m) => open(m, 'home'),
    ayar: (m) => open(m, 'home'),
    mod: (m) => open(m, 'mod'),
    eglence: (m) => open(m, 'fun'),
    'eğlence': (m) => open(m, 'fun'),
  });

  // ---------- Yardım menüsü: Eğlence kategorisi ----------
  const oldHome = HELP_PAGES.home;
  HELP_PAGES.home = () => {
    const p = oldHome();
    p.description += '\nYetkililer: `!panel` ile her şeyi butonlarla yönetebilir.';
    p.fields.splice(Math.max(0, p.fields.length - 1), 0, { name: '🎮 Eğlence', value: 'Kelime türetmece, sayı sayma', inline: true });
    return p;
  };
  const oldCommunity = HELP_PAGES.community;
  HELP_PAGES.community = () => {
    const p = oldCommunity();
    p.fields = p.fields.filter((f) => !/Kelime türetmece|Sayı sayma/.test(f.name));
    p.fields.push({ name: '🎛️ Yönetim paneli', value: 'Başvuru, şikayet, etkinlik ve hoş geldin ayarları için yetkililer `!panel` yazabilir.', inline: false });
    return p;
  };
  HELP_PAGES.fun = () => ({
    title: '🎮 Eğlence', color: COLORS.ok,
    fields: [
      { name: '🔤 Kelime türetmece', value: 'Kanalda sadece **tek kelime** yazılır. Kelime, öncekinin son harfiyle başlamalı ve TDK sözlüğünde bulunmalı.', inline: false },
      { name: '🔢 Sayı sayma', value: 'Kanalda sırayla rakam yazılır (1, 2, 3...). Yanlış sayı silinir.', inline: false },
      { name: '🎁 Oyun emojisi', value: 'Doğru kelime ve sayıya bot bu emojiyle tepki verir.', inline: false },
      { name: '⚙️ Kurulum (yetkililer)', value: '`!eglence` ya da `!panel` → 🎮 Eğlence. Kanalı seçip oyunu başlatabilirsin.', inline: false },
    ],
    footer: { text: 'RINAE • Eğlence' },
  });

  // ---------- Yardım sayfalarını otomatik şıklaştır ----------
  // Sorun: komut yazılı alan başlıkları (`!filtre ...`) başlıkta ham ters tırnakla görünüyor, her komut ayrı büyük blok oluyor.
  // Çözüm: adı komutla başlayan (`!...`) alanlar tek bir "⌨️ Komutlar" alanında toplanır:
  //   `!komut`
  //   ↳ açıklama
  // Diğer alanlara (emoji başlıklı bölümler) dokunulmaz. Kapatmak için: RINAE_YARDIM_STIL=0
  const CMD_NAME = /^\s*`?!/;
  function prettyHelp(p) {
    if (!p || !Array.isArray(p.fields)) return p;
    const isCmd = (f) => CMD_NAME.test(String(f?.name ?? ''));
    const cmds = p.fields.filter(isCmd);
    if (!cmds.length) return p;
    const blocks = cmds.map((f) => {
      const n = String(f.name).trim();
      const head = n.includes('`') ? n : `\`${n}\``;
      const body = String(f.value ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `↳ ${l}`).join('\n');
      return body ? `${head}\n${body}` : head;
    });
    const fields = [];
    let cur = '';
    for (const bl of blocks) {
      if (cur && cur.length + bl.length + 2 > 1000) { fields.push(cur); cur = ''; }
      cur += (cur ? '\n\n' : '') + bl.slice(0, 1000);
    }
    if (cur) fields.push(cur);
    const cmdFields = fields.map((value, i) => ({ name: i === 0 ? '⌨️ Komutlar' : '⌨️ Komutlar (devam)', value, inline: false }));
    return { ...p, fields: [...cmdFields, ...p.fields.filter((f) => !isCmd(f))] };
  }
  const helpWrapped = new WeakSet();
  function wrapHelpPages() {
    for (const k of Object.keys(HELP_PAGES)) {
      const fn = HELP_PAGES[k];
      if (typeof fn !== 'function' || helpWrapped.has(fn)) continue;
      const w = (...a) => { const r = fn(...a); return r && typeof r.then === 'function' ? r.then(prettyHelp) : prettyHelp(r); };
      helpWrapped.add(w);
      HELP_PAGES[k] = w;
    }
  }
  if (process.env.RINAE_YARDIM_STIL !== '0') {
    wrapHelpPages();
    // sonradan yüklenen modüllerin eklediği sayfalar da kapsansın
    const t = setTimeout(wrapHelpPages, 5000); t.unref?.();
  }

  return { handleInteraction, onMessage, open };
}

module.exports = { init };