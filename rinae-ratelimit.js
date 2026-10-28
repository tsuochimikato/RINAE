// RINAE - Hız sınırı (429) koruması
// Jubbio "RATE_LIMITED, retry_after: X" dediğinde istek hata verip düşmesin diye X saniye bekleyip tekrar dener.
// Tüm modüllerin mesaj/rol/ban istekleri client.rest.request üzerinden gittiği için tek yerden hepsini kapsar.
// Kullanım (index.js'te client oluşturulduktan hemen sonra):
//   require('./rinae-ratelimit.js').install(client);
'use strict';

const MAX_RETRIES = 3;      // en fazla kaç kez tekrar denensin
const MAX_WAIT_MS = 8000;   // tek seferde en fazla bu kadar beklenir
const EXTRA_MS = 150;       // retry_after'a eklenen güvenlik payı

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hatadan "kaç saniye beklemeli" bilgisini çıkarır; hız sınırı hatası değilse null döner
function retryAfterSec(err) {
  if (!err) return null;
  const direct = err.retry_after ?? err.retryAfter ?? err.data?.retry_after ?? err.body?.retry_after;
  if (direct != null && Number.isFinite(Number(direct))) return Number(direct);
  const msg = String(err.message ?? err);
  if (!/429|RATE_LIMITED|rate limited/i.test(msg)) return null;
  const m = msg.match(/"retry_after"\s*:\s*([\d.]+)/);
  return m ? Number(m[1]) : 1; // süre okunamadıysa 1 sn varsay
}

function install(client) {
  const rest = client?.rest;
  if (!rest || typeof rest.request !== 'function') {
    console.warn('[ratelimit] client.rest.request bulunamadı, koruma kurulamadı.');
    return false;
  }
  if (rest.__rinaeRateLimit) return true; // iki kez kurulmasın
  rest.__rinaeRateLimit = true;

  const original = rest.request.bind(rest);
  rest.request = async function request(...args) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await original(...args);
      } catch (err) {
        const wait = retryAfterSec(err);
        if (wait == null || attempt >= MAX_RETRIES) throw err;
        const ms = Math.min(MAX_WAIT_MS, Math.ceil(wait * 1000) + EXTRA_MS);
        console.warn(`[ratelimit] 429 alındı (${args[0]} ${String(args[1]).split('?')[0]}), ${(ms / 1000).toFixed(1)} sn bekleyip tekrar denenecek (${attempt + 1}/${MAX_RETRIES})`);
        await sleep(ms);
      }
    }
  };
  return true;
}

module.exports = { install, retryAfterSec };
