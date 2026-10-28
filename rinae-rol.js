// RINAE - Serbest rol sistemi (botu etiketleyip rol etiketleyerek rol alma)
// Üyeler:   @RINAE @Valorant            -> Valorant rolünü alır
//           @RINAE @Valorant çıkar      -> rolü bırakır
//           @RINAE roller               -> alabileceği rolleri listeler
// Yönetici: !rol-izin ekle <@rol|rolID|rol adı> | sil <...> | liste | temizle
// Alınabilecek roller SUNUCUYA ÖZELDİR ve sadece yöneticilerin eklediği roller verilir.
// Ekstra emniyet: yönetici/yetki sahibi roller listeye eklenemez; sonradan yetki verilirse bot vermeyi reddeder
// (her vermeden hemen önce rol bilgisi taze çekilir, önbellekteki eski bilgiye güvenilmez).
//
// BAĞLANTI: index.js messageCreate içinde, bot sohbet/soru-cevap kısmına geçmeden ÖNCE şunu çağır:
//     if (await rol.onMessage(message)) return;
// ve kapanışta rol.flush() çağrılsın (module.exports'taki flush).
'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'rinae-rol.json');
const MAX_PER_MSG = 5;          // tek mesajda en fazla kaç rol
const COOLDOWN_MS = 4000;       // aynı kişi için bekleme
const MAX_ROLES_PER_GUILD = 50;
const ROLE_CACHE_MS = 60_000;

// Bu yetkilerden birine sahip roller verilmez. (Jubbio'nun yetki adları: permission_names)
const DANGEROUS_RE = /administrator|manage|\bkick\b|\bban\b|moderate|timeout|everyone|\bmute\b|\bdeafen\b|move members/i;

const T = (t) => String(t ?? '').toLocaleLowerCase('tr-TR');
const asc = (t) => T(t).replace(/\u0307/g, '').replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i')
  .replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u');

function init(ctx) {
  const { client, commands, HELP_PAGES, requirePerm, sendPanel, guildIdOf, COLORS, ADMIN_ONLY, actions, ev, who } = ctx;

  // ---------- Kalıcı veri: { guilds: { [sunucuId]: { roles: [rolId, ...] } } } ----------
  let data = { guilds: {} };
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
    if (j && typeof j.guilds === 'object') data = j;
  } catch { /* ilk çalıştırma */ }
  function save() {
    try {
      fs.writeFileSync(FILE + '.tmp', JSON.stringify(data, null, 2));
      fs.renameSync(FILE + '.tmp', FILE);
    } catch (e) { console.warn('rinae-rol.json kaydedilemedi:', e.message); }
  }
  const allowed = (gid) => (data.guilds[gid]?.roles ?? []);

  // Log hatası asla rol işlemini bozmasın (ev/who/actions eksik olsa bile)
  async function logEv(title, color, fields) {
    try {
      if (typeof actions?.log !== 'function' || typeof ev !== 'function') return;
      await actions.log(ev(title, color, fields));
    } catch (e) { console.warn('[rol] log yazılamadı:', e?.message || e); }
  }
  const whoStr = (uid) => { try { return typeof who === 'function' ? who(uid) : `<@${uid}>`; } catch { return `<@${uid}>`; } };

  // ---------- Rol listesi (önbellekli; fresh=true önbelleği atlar) ----------
  const rolesCache = new Map();
  async function getRoles(gid, fresh = false) {
    const c = rolesCache.get(gid);
    if (!fresh && c && Date.now() - c.t < ROLE_CACHE_MS) return c.v;
    try {
      const r = await client.rest.getRoles(gid);
      const list = Array.isArray(r) ? r : Array.isArray(r?.roles) ? r.roles : Object.values(r || {});
      rolesCache.set(gid, { t: Date.now(), v: list });
      return list;
    } catch (e) {
      console.warn('[rol] roller alınamadı:', e?.message || e);
      return fresh && c ? null : (c?.v ?? null); // taze istenip alınamadıysa eski bilgiye güvenme
    }
  }

  // Yetkili/tehlikeli rol mu? Emin olamazsak "tehlikeli" sayılır.
  function dangerous(role) {
    const names = Array.isArray(role.permission_names) ? role.permission_names.join('|') : '';
    if (DANGEROUS_RE.test(names)) return true;
    try {
      const p = BigInt(role.permissions ?? 0);
      if ((p & 8n) === 8n) return true;      // Administrator biti
      if (p >= (1n << 52n)) return true;     // "tüm yetkiler" benzeri çok büyük değerler
    } catch { return true; }
    return false;
  }

  // ---------- Yardımcılar ----------
  function botMentioned(content) {
    const me = client.user?.id;
    if (!me) return false;
    if (new RegExp(`<@!?${me}>`).test(content)) return true;
    const name = client.user?.username;
    return Boolean(name && new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'iu').test(content));
  }
  const REMOVE_RE = /\b(cikar|kaldir|sil|birak|istemiyorum)\b/;
  const LIST_RE = /^(roller|rol listesi|rolleri goster|rolleri listele|hangi roller|roller neler|roller neler var|alabilecegim roller)\??$/;
  const lastUse = new Map();
  setInterval(() => { // bellek şişmesin
    const limit = Date.now() - 60_000;
    for (const [k, t] of lastUse) if (t < limit) lastUse.delete(k);
  }, 5 * 60_000).unref?.();

  function mentionedRoleIds(message) {
    const ids = new Set([...String(message.content).matchAll(/<@&(\d+)>/g)].map((m) => m[1]));
    const r = message.mentions?.roles;
    const push = (v) => { if (v != null) ids.add(String(typeof v === 'object' ? v.id : v)); };
    if (Array.isArray(r)) r.forEach(push);
    else if (r && typeof r.forEach === 'function') r.forEach((v, k) => push(v?.id ?? k));
    ids.delete('undefined');
    return ids;
  }

  async function hasRole(gid, uid, roleId) {
    try {
      const m = await client.rest.getMember(gid, uid);
      const roles = m?.roles ?? m?.member?.roles ?? [];
      return roles.some((r) => String(typeof r === 'object' ? r.id : r) === String(roleId));
    } catch { return false; }
  }

  // Üyelere gösterilecek "alabileceğin roller" metni (yetkili hale gelmiş roller listede görünmez)
  function publicList(gid, roles) {
    const names = allowed(gid)
      .map((id) => roles?.find((r) => String(r.id) === id))
      .filter((r) => r && !dangerous(r))
      .map((r) => `**${r.name}**`);
    return names.length ? names.join(', ') : '—';
  }

  // ---------- Üyelerin kullandığı kısım (index.js messageCreate içinden çağrılır) ----------
  async function onMessage(message) {
    if (message.author?.bot) return false; // botlar rol alıp veremez
    const gid = guildIdOf(message);
    if (!gid || !allowed(gid).length) return false; // bu sunucuda ayar yoksa karışma
    const content = String(message.content ?? '');
    if (!botMentioned(content)) return false;

    let ids = mentionedRoleIds(message);
    let roles = null;

    // Etiket yerine düz yazıyla "@Rol Adı" yazıldıysa, sadece izinli rollerin adlarına bakılır
    if (!ids.size) {
      roles = await getRoles(gid);
      if (roles) {
        const text = asc(content);
        for (const id of allowed(gid)) {
          const r = roles.find((x) => String(x.id) === id);
          if (r && r.name && text.includes('@' + asc(r.name))) ids.add(id);
        }
      }
    }

    const rest = asc(content.replace(/<@!?&?\d+>/g, ' ').replace(/@\S+/g, ' ')).replace(/\s+/g, ' ').trim();

    if (!ids.size) {
      // "@RINAE roller" gibi kısa bir liste isteği
      if (LIST_RE.test(rest)) {
        roles = roles ?? (await getRoles(gid));
        await message.reply(`Alabileceğin roller: ${publicList(gid, roles)}\nAlmak için: \`@${client.user?.username ?? 'RINAE'} @rol\`  •  Bırakmak için: \`@${client.user?.username ?? 'RINAE'} @rol çıkar\``);
        return true;
      }
      return false; // rol etiketi yok: normal sohbet/soru-cevap devam etsin
    }

    const wanted = [...ids].filter((id) => allowed(gid).includes(id)).slice(0, MAX_PER_MSG);

    roles = roles ?? (await getRoles(gid));
    const nameOf = (id) => roles?.find((r) => String(r.id) === String(id))?.name ?? id;

    if (!wanted.length) {
      // İzinsiz rol istendi. Uzun bir soruysa (ör. yetkili sorusu) karışma, sadece kısa "rol isteme" mesajlarına cevap ver.
      if (rest.length > 25) return false;
      await message.reply(`Bu rolü kendin alamazsın. Alabileceğin roller: ${publicList(gid, roles)}`);
      return true;
    }

    const uid = String(message.author?.id);
    const k = `${gid}:${uid}`;
    if (Date.now() - (lastUse.get(k) || 0) < COOLDOWN_MS) return true; // çok hızlı denenirse sessizce yut
    lastUse.set(k, Date.now());

    // Vermeden hemen önce rol bilgisini TAZE çek: yöneticilik yetkisi yeni verilmiş bir rol önbellekten sızmasın
    const fresh = await getRoles(gid, true);
    if (!fresh) { await message.reply('Rolleri şu an doğrulayamadım, birazdan tekrar dene.'); return true; }
    roles = fresh;

    const removing = REMOVE_RE.test(rest);
    const lines = [];
    for (const id of wanted) {
      const role = roles.find((r) => String(r.id) === id);
      if (!role) { lines.push('❌ Bu rol artık yok, yetkililere haber ver.'); continue; }
      // Rolü BIRAKMAK her zaman serbest (sonradan yetkili olmuş bir rolden de çıkılabilsin); sadece ALMAK engellenir
      if (!removing && dangerous(role)) { lines.push(`⛔ **${role.name}** yetkili bir rol olduğu için verilemez.`); continue; }
      const url = `/bot/guilds/${gid}/members/${uid}/roles/${id}`;
      try {
        if (removing) {
          if (!(await hasRole(gid, uid, id))) { lines.push(`ℹ️ **${role.name}** rolüne zaten sahip değilsin.`); continue; }
          await client.rest.request('DELETE', url);
          lines.push(`✅ **${role.name}** rolü senden alındı.`);
          await logEv('🎭 Serbest rol bırakıldı', COLORS?.warn, [['Kullanıcı', whoStr(uid)], ['Rol', role.name]]);
        } else {
          if (await hasRole(gid, uid, id)) { lines.push(`ℹ️ **${role.name}** rolüne zaten sahipsin. Bırakmak için: @RINAE @${role.name} çıkar`); continue; }
          await client.rest.request('PUT', url);
          lines.push(`✅ **${role.name}** rolü verildi!`);
          await logEv('🎭 Serbest rol alındı', COLORS?.ok, [['Kullanıcı', whoStr(uid)], ['Rol', role.name]]);
        }
      } catch (e) {
        console.warn('[rol] işlem başarısız:', e?.message || e);
        lines.push(`❌ **${role.name}** rolünü ${removing ? 'alamadım' : 'veremedim'}. Botun rolü bu rolün üstünde olmalı.`);
      }
    }
    await message.reply(lines.join('\n'));
    return true;
  }

  // ---------- Yöneticilerin kullandığı komut ----------
  async function resolveRole(gid, raw) {
    const roles = await getRoles(gid, true);
    if (!roles) return { error: 'Rolleri alamadım, birazdan tekrar dene.' };
    const text = String(raw ?? '').trim();
    const id = text.match(/<@&(\d+)>/)?.[1] ?? (/^\d{5,25}$/.test(text) ? text : null);
    const role = id
      ? roles.find((r) => String(r.id) === id)
      : roles.find((r) => asc(r.name) === asc(text.replace(/^@/, '').trim()));
    return role ? { role } : { error: 'Bu rolü bulamadım. Rolü etiketle, ID yaz ya da tam adını yaz.' };
  }

  async function rolIzin(message, args) {
    if (!(await requirePerm(message, 'Administrator', ADMIN_ONLY))) return;
    const gid = guildIdOf(message);
    if (!gid) return message.reply('Bu komut sadece sunucuda kullanılabilir.');
    const sub = T(args[0]);
    const rest = args.slice(1).join(' ');
    const G = (data.guilds[gid] ||= { roles: [] });

    if (sub === 'ekle') {
      if (!rest) return message.reply('Kullanım: !rol-izin ekle <@rol | rolID | rol adı>');
      const { role, error } = await resolveRole(gid, rest);
      if (error) return message.reply(error);
      if (role.is_default) return message.reply('@everyone rolü eklenemez.');
      if (dangerous(role)) return message.reply(`⛔ **${role.name}** yetkili bir rol (yönetici/yönetim yetkisi var), üyelerin kendi başına almasına izin veremem.`);
      if (G.roles.includes(String(role.id))) return message.reply(`**${role.name}** zaten listede.`);
      if (G.roles.length >= MAX_ROLES_PER_GUILD) return message.reply(`En fazla ${MAX_ROLES_PER_GUILD} rol eklenebilir.`);
      G.roles.push(String(role.id));
      save();
      await logEv('🎭 Serbest rol eklendi', COLORS?.ok, [['Rol', role.name], ['Yetkili', whoStr(String(message.author?.id))]]);
      return message.reply(`✅ **${role.name}** artık alınabilir. Üyeler \`@RINAE @${role.name}\` yazarak alabilir.`);
    }

    if (sub === 'sil' || sub === 'çıkar' || sub === 'cikar') {
      if (!rest) return message.reply('Kullanım: !rol-izin sil <@rol | rolID | rol adı>');
      const text = rest.trim();
      let id = text.match(/<@&(\d+)>/)?.[1] ?? (/^\d{5,25}$/.test(text) ? text : null);
      if (!id) { const r = await resolveRole(gid, text); id = r.role ? String(r.role.id) : null; }
      if (!id || !G.roles.includes(id)) return message.reply('Bu rol listede yok. Liste için: !rol-izin liste');
      G.roles = G.roles.filter((x) => x !== id);
      save();
      return message.reply('✅ Rol listeden çıkarıldı. (Rolü zaten almış olanlar rolünü korur.)');
    }

    if (sub === 'temizle') {
      const n = G.roles.length;
      G.roles = [];
      save();
      return message.reply(`Listedeki ${n} rolün hepsi çıkarıldı.`);
    }

    // liste / yardım
    const roles = await getRoles(gid, true);
    const find = (id) => roles?.find((r) => String(r.id) === id);
    const lines = G.roles.map((id) => {
      const r = find(id);
      if (!r) return `• ⚠️ silinmiş rol (\`${id}\`)`;
      if (dangerous(r)) return `• ⛔ **${r.name}** (\`${id}\`) — artık yetkili bir rol, **verilmiyor**. Listeden çıkarman önerilir.`;
      return `• **${r.name}** (\`${id}\`)`;
    });
    return sendPanel(message, { embeds: [{
      title: '🎭 Alınabilir Roller',
      description: (lines.join('\n') || 'Henüz alınabilir rol yok.')
        + '\n\n`!rol-izin ekle <@rol|rolID|ad>`\n`!rol-izin sil <@rol|rolID|ad>`\n`!rol-izin temizle`',
      color: COLORS?.main,
      footer: { text: 'Üyeler: @RINAE @rol → alır • @RINAE @rol çıkar → bırakır • @RINAE roller → liste' },
    }] });
  }

  for (const n of ['rol-izin', 'rolizin', 'oto-rol', 'otorol', 'serbest-rol']) {
    if (Object.hasOwn(commands, n)) console.warn(`[rol] !${n} başka bir modülde de tanımlı, bu modül üzerine yazıyor`);
    commands[n] = rolIzin;
  }

  // ---------- Yardım menüsüne ekle ----------
  const oldRoles = HELP_PAGES.roles;
  HELP_PAGES.roles = () => {
    const p = oldRoles ? oldRoles() : { title: '🎭 Rol & Log Komutları', color: COLORS?.ok, fields: [] };
    if (Array.isArray(p.fields) && !p.fields.some((f) => String(f.name).includes('rol-izin'))) {
      p.fields.push({ name: '`!rol-izin ekle|sil|liste|temizle`', value: 'Üyelerin kendi başına alabileceği rolleri belirler (sunucuya özel). Üyeler `@RINAE @rol` yazarak alır, `@RINAE @rol çıkar` ile bırakır, `@RINAE roller` ile listeyi görür.', inline: false });
    }
    return p;
  };

  return { onMessage, flush: save };
}

module.exports = { init };
