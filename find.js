const fs = require('fs');
const s = fs.readFileSync('index.js', 'utf8');
let depth = 0, line = 1, col0 = true, mode = 'code', q = '', hits = 0;
const tpl = [];
for (let i = 0; i < s.length; i++) {
  const c = s[i], d = s[i + 1];
  if (c === '\n') { line++; col0 = true; if (mode === 'line') mode = 'code'; continue; }
  if (mode === 'line') continue;
  if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i++; } continue; }
  if (mode === 'str') { if (c === '\\') i++; else if (c === q) mode = 'code'; continue; }
  if (mode === 'tpl') {
    if (c === '\\') i++;
    else if (c === '`') mode = 'code';
    else if (c === '$' && d === '{') { tpl.push(depth); depth++; mode = 'code'; i++; }
    continue;
  }
  if (col0 && depth > 0 && /^(async function|function |client\.on|const |let |module\.exports)/.test(s.slice(i, i + 20))) {
    console.log(`Satır ${line}: en solda başlıyor ama önceki blok kapanmamış (derinlik ${depth})`);
    if (++hits >= 3) process.exit();
  }
  if (c !== ' ' && c !== '\t' && c !== '\r') col0 = false;
  if (c === '/' && d === '/') mode = 'line';
  else if (c === '/' && d === '*') { mode = 'block'; i++; }
  else if (c === '"' || c === "'") { mode = 'str'; q = c; }
  else if (c === '`') mode = 'tpl';
  else if (c === '{' || c === '(' || c === '[') depth++;
  else if (c === '}' && tpl.length && depth === tpl[tpl.length - 1] + 1) { tpl.pop(); depth--; mode = 'tpl'; }
  else if (c === '}' || c === ')' || c === ']') depth--;
}
console.log('Dosya sonunda kalan derinlik:', depth);