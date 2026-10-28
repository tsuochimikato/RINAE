// RINAE birleştirici: index.js + rinae-plus.js -> tek dosya (index.js)
// Kullanım: aynı klasörde  node birlestir.js
const fs = require('fs');
const path = require('path');

const idx = path.join(__dirname, 'index.js');
const plusFile = path.join(__dirname, 'rinae-plus.js');
if (!fs.existsSync(idx) || !fs.existsSync(plusFile)) {
  console.error('index.js ve rinae-plus.js bu dosyayla aynı klasörde olmalı.');
  process.exit(1);
}
let src = fs.readFileSync(idx, 'utf-8').replace(/\r\n/g, '\n');
if (src.includes('const rinaePlus = (() =>')) { console.error('index.js zaten birleştirilmiş.'); process.exit(1); }
let plus = fs.readFileSync(plusFile, 'utf-8').replace(/\r\n/g, '\n');
if (!plus.includes('module.exports = { init, isSuper, CREATOR_ID };')) { console.error('rinae-plus.js beklenen sürümde değil.'); process.exit(1); }
plus = plus.replace('module.exports = { init, isSuper, CREATOR_ID };', 'return { init, isSuper, CREATOR_ID };');

let failed = false;
function rep(name, from, to) {
  const n = src.split(from).length - 1;
  if (n !== 1) { console.error(`✗ [${name}] ${n} yerde bulundu (1 olmalı). Bu bölümü elle düzeltmen gerekebilir.`); failed = true; return; }
  src = src.replace(from, () => to);
  console.log(`✓ ${name}`);
}

rep('1. güvenlik katmanı + RINAE+ modülü (en üste)',
  "const path = require('path');\n",
  "const path = require('path');\n\n// ===================== RINAE+ MODÜLÜ (rinae-plus.js buraya gömüldü) =====================\nconst rinaePlus = (() => {\n" + plus + "\n})();\n// ========================================================================================\n\n");
rep('2. plus değişkeni', 'let ek = null;', 'let ek = null;\nlet plus = null;');
rep('3. isOwnerOf (sahip 1500 + tam yetkililer)',
  'function isOwnerOf(message) {\n  const guild = guildOf(message);',
  "function isOwnerOf(message) {\n  if (message.author?.id && plus?.isSuper(message.author.id)) return true; // RINAE sahibi + !tam-yetki\n  const guild = guildOf(message);");
rep('4. plus başlatma',
  '  getRegRecords: () => regRecords, respondUpdate, respondPrivate,\n});',
  "  getRegRecords: () => regRecords, respondUpdate, respondPrivate,\n});\n\nplus = rinaePlus.init({\n  client, core, CONFIG, commands, actions, HELP_PAGES, ek,\n  postToChannel, say, sendPanel, ev, who, COLORS, cleanId, trLower, guildIdOf, isOwnerOf,\n  resolveUserIds, mentionIds, requirePerm, findBannedWord, punishProfanity,\n  getRegRecords: () => regRecords,\n  getStrikes: () => ({ strikes, adStrikes }),\n  flushAll: () => { saveSettings(); saveRecords(); ek.flush(); },\n});");
rep('5a. oyunlar / etiketle-sor / yeniden başlatma kancası',
  '    if (!isCmd && (await ek.onMessage(message))) return;',
  '    if (await plus.beforeMessage(message, isCmd)) return; // oyunlar, etiketle-sor, yeniden başlatma\n    if (!isCmd && (await ek.onMessage(message))) return;');
rep('5b. CAPS / İ eşleme',
  '      const key = name?.toLowerCase();',
  "      let key = (name ?? '').toLowerCase();\n      if (!Object.hasOwn(commands, key)) key = plus.normKey(name ?? '');");
rep('5c. bakım modu kapısı',
  '        if (!(await ek.canRun(message, key))) return; // !komut-izin kontrolü',
  '        if (await plus.gate(message, key)) return; // bakım modu\n        if (!(await ek.canRun(message, key))) return; // !komut-izin kontrolü');
rep('5d. yanlış komut önerisi',
  '        return;\n      }\n    }\n\n    // Sunucu sahibi, yöneticiler ve muaf',
  '        return;\n      }\n      if (await plus.unknownCommand(message, key, args)) return; // "bunu mu demek istedin?"\n    }\n\n    // Sunucu sahibi, yöneticiler ve muaf');
rep('6. filtre butonu yetkisi',
  'if (!(await ek.isAdminId(gid, userId))) {',
  'if (!plus.isSuper(userId) && !(await ek.isAdminId(gid, userId))) {');
rep('7. kapanışta veri kaydı',
  '  ek?.flush();\n  client.destroy();',
  '  ek?.flush();\n  plus?.flush();\n  client.destroy();');

if (failed) { console.error('\nBazı bölümler uyuşmadı, hiçbir şey yazılmadı.'); process.exit(1); }
fs.copyFileSync(idx, path.join(__dirname, 'index.eski.js'));
fs.writeFileSync(idx, src);
console.log('\nBitti! Eski dosya index.eski.js olarak yedeklendi. Artık sadece index.js çalışıyor (rinae-plus.js\'e gerek yok).');
