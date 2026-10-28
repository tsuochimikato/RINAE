// RINAE GUI yaması: index.js'e gereken 6 düzenlemeyi otomatik uygular.
// Kullanım (index.js ve rinae-gui.js ile aynı klasörde):  node apply-gui-patch.js
// Eşleşmeyen bir yer olursa HİÇBİR şey yazmaz. Başarılıysa önce index.js.bak-gui yedeği alır.
const fs = require('fs');
const FILE = 'index.js';
let s = fs.readFileSync(FILE, 'utf-8');
if (s.includes("require('./rinae-gui.js')")) { console.log('Yama zaten uygulanmış.'); process.exit(0); }

const edits = [
  ['1) ek return: D', /onRegistered, onJoin, flush \};/, 'onRegistered, onJoin, flush, D };'],
  ['2) plus return: G, emoji', /(flush: \(\) => \{ P\.flush\(\); S\.flush\(\); \},)/, '$1\n    G, emoji: () => P.data.emoji,'],
  ['3) yardım sekmesi: Eğlence', /(\['community', '🎪 Topluluk'\], \['stats', '📊 İstatistik'\],)/, "$1 ['fun', '🎮 Eğlence'],"],
  ['4) gui başlatma', /(flushAll: \(\) => \{ saveSettings\(\); saveRecords\(\); ek\.flush\(\); \},\s*\}\);)/,
    `$1

// Butonlu arayüz katmanı (!panel)
const gui = require('./rinae-gui.js').init({
  commands, actions, HELP_PAGES, ek, plus, FILTERS, CONFIG, REG, getRegRecords: () => regRecords,
  makeRow, postToChannel, sendPanel, respondUpdate, respondPrivate, requirePerm,
  guildIdOf, COLORS, cleanId, trLower,
});`],
  ['5) messageCreate kancası', /(const isCmd = message\.content\.startsWith\(CONFIG\.prefix\);)/, '$1\n    if (await gui.onMessage(message)) return; // GUI yazı girişi'],
  ['6) interactionCreate kancası', /(\n\s*)(\/\/ Paneli açan kişi dışındakiler kullanamasın)/,
    "$1if (kind === 'g') { await gui.handleInteraction(interaction, { parts, userId, gid }); return; }$1$2"],
];

for (const [name, re, rep] of edits) {
  const n = (s.match(new RegExp(re.source, 'g')) || []).length;
  if (n !== 1) { console.error(`✗ ${name}: ${n} eşleşme (1 olmalıydı). Hiçbir şey değiştirilmedi.`); process.exit(1); }
  s = s.replace(re, rep);
  console.log(`✓ ${name}`);
}
fs.copyFileSync(FILE, FILE + '.bak-gui');
fs.writeFileSync(FILE, s);
console.log('Tamam. Yedek: index.js.bak-gui');
