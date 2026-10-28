// RINAE - Evrensel emoji koruması
// Jubbio, bir sunucunun özel (custom) emojisini başka sunucuda kullanmayı abonelik şartına bağlıyor:
//   403 "Subscription required to use emojis from other guilds"
// Bu modül o hatayı yakalar, mesajdaki özel emojileri standart emojiyle değiştirip aynı isteği tekrar gönderir.
// Emojinin kendi sunucusunda hata olmadığı için orada özel emoji aynen kalır.
// Bir sunucuda hata alındıysa o sunucu hatırlanır, sonraki mesajlar baştan standart emojiyle gider (ekstra istek yok).
//
// Kullanım (index.js'te client oluşturulduktan hemen sonra, ratelimit'ten SONRA):
//   require('./rinae-ratelimit.js').install(client);
//   require('./rinae-emoji.js').install(client);
'use strict';

// Özel emoji ID'si -> yerine konacak standart emoji. Burada olmayan özel emojiler :ad: yazısına çevrilir.
const REPLACEMENTS = {
  '636640169683853312': '🪙', // coin_flip (dönen coin)
  '636640138578894848': '📜', // coin_yazi
  '636640119742275584': '🪙', // coin_tura (para birimi simgesi)
};

const CUSTOM_EMOJI = /<a?:([A-Za-z0-9_~]+):(\d+)>/g;
const ERR_RE = /Subscription required to use emojis|emojis from other guilds/i;

const hasCustom = (text) => { CUSTOM_EMOJI.lastIndex = 0; return CUSTOM_EMOJI.test(text); };
const swap = (text) => text.replace(CUSTOM_EMOJI, (_, name, id) => REPLACEMENTS[id] ?? `:${name}:`);

// Gövde (body) içindeki bütün özel emojileri değiştirir; değişen bir şey yoksa null döner
function sanitizeBody(body) {
  if (body == null || typeof body !== 'object') return null;
  let text;
  try { text = JSON.stringify(body); } catch { return null; }
  if (!hasCustom(text)) return null;
  try { return JSON.parse(swap(text)); } catch { return null; }
}

const guildOfUrl = (url) => String(url ?? '').match(/\/guilds\/(\d+)/)?.[1] ?? null;

function install(client, extra = {}) {
  const rest = client?.rest;
  if (!rest || typeof rest.request !== 'function') {
    console.warn('[emoji] client.rest.request bulunamadı, koruma kurulamadı.');
    return false;
  }
  if (rest.__rinaeEmoji) return true;
  rest.__rinaeEmoji = true;
  Object.assign(REPLACEMENTS, extra.replacements || {});

  const blocked = new Set(); // özel emoji kullanamayan sunucular (bu oturumda öğrenilir)
  const original = rest.request.bind(rest);

  rest.request = async function request(method, url, body, ...rest2) {
    const gid = guildOfUrl(url);
    // Bu sunucuda daha önce hata aldıysak baştan standart emojiyle gönder
    if (gid && blocked.has(gid) && body) {
      const clean = sanitizeBody(body);
      if (clean) body = clean;
    }
    try {
      return await original(method, url, body, ...rest2);
    } catch (err) {
      if (!ERR_RE.test(String(err?.message ?? err))) throw err;
      const clean = sanitizeBody(body);
      if (!clean) throw err; // hatanın sebebi bizim değiştirebileceğimiz bir emoji değil
      if (gid && !blocked.has(gid)) {
        blocked.add(gid);
        console.warn(`[emoji] ${gid} sunucusunda özel emoji kullanılamıyor, bu sunucuda standart emoji kullanılacak.`);
      }
      return original(method, url, clean, ...rest2);
    }
  };
  return true;
}

module.exports = { install, sanitizeBody };
