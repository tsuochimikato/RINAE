const fs = require('fs'), vm = require('vm');
const L = fs.readFileSync('index.js', 'utf8').split('\n');
const a = L.findIndex(l => l.startsWith('function initEk('));
const b = L.findIndex((l, i) => i > a && /^\s*return \{ onMessage/.test(l));
if (a < 0 || b < 0) { console.log('initEk ya da return satırı bulunamadı', a, b); process.exit(); }
const starts = [];
for (let i = a + 1; i <= b; i++) {
  if (/^ {2}\S/.test(L[i]) && !/^ {2}[}\])./]/.test(L[i]) && !/^ {2}\/\//.test(L[i])) starts.push(i);
}
starts.push(b + 1);
let bad = 0;
for (let k = 0; k < starts.length - 1; k++) {
  const chunk = L.slice(starts[k], starts[k + 1]).join('\n');
  try { new vm.Script('(async function(){' + chunk + '\n})'); }
  catch (e) {
    bad++;
    console.log(`Bozuk blok: satır ${starts[k] + 1} - ${starts[k + 1]} | ${L[starts[k]].trim().slice(0, 70)}`);
  }
}
console.log(bad ? 'Bitti, yukarıdakiler bozuk.' : 'Hiçbir blok bozuk çıkmadı.');