// RINAE Aile Sistemi: soy ağacını PNG olarak çizer (@napi-rs/canvas)
'use strict';

const { createCanvas, loadImage } = require('@napi-rs/canvas');

const CARD_W = 190, CARD_H = 68, AV = 46;
const COUPLE_GAP = 40, UNIT_GAP = 28, ROW_GAP = 72, PAD = 36, TITLE_H = 76;
const MAX_UNITS = 10, MAX_DEPTH = 3;
const FONT = 'sans-serif';
const PINK = '#ff7eb6';

// ---------- Satırları (kuşakları) oluştur ----------
function buildRows(g, root, api) {
  const { parentsOf, childrenOf, kidsOf } = api;
  const seen = new Set();
  const unit = (u) => {
    if (seen.has(u)) return null;
    const ids = [u];
    seen.add(u);
    const s = g.spouse[u];
    if (s && !seen.has(s)) { ids.push(s); seen.add(s); }
    return { ids };
  };
  const uniq = (arr) => [...new Set(arr)];

  // orta satır: kullanıcı + eşi, yanında kardeşler
  const rootUnit = unit(root);
  const sibIds = uniq(parentsOf(g, root).flatMap((p) => childrenOf(g, p))).filter((x) => x !== root);
  const mid = [rootUnit, ...sibIds.map(unit).filter(Boolean)];
  const rows = [mid];

  // yukarı: ebeveynler ve büyükanne/büyükbabalar
  const up1 = uniq(parentsOf(g, root)).map(unit).filter(Boolean);
  if (up1.length) {
    rows.unshift(up1);
    const up2 = uniq(up1.flatMap((u) => u.ids).flatMap((x) => parentsOf(g, x))).map(unit).filter(Boolean);
    if (up2.length) rows.unshift(up2);
  }

  // aşağı: çocuklar, torunlar...
  let members = [root];
  for (let d = 0; d < MAX_DEPTH; d++) {
    const kids = uniq(members.flatMap((m) => kidsOf(g, m))).filter((c) => !seen.has(c));
    const units = kids.map(unit).filter(Boolean);
    if (!units.length) break;
    rows.push(units);
    members = units.flatMap((u) => u.ids);
  }

  // her birimi bir üst satırdaki ebeveyn birimine bağla
  for (let r = 1; r < rows.length; r++) {
    for (const u of rows[r]) {
      for (const id of u.ids) {
        const ps = parentsOf(g, id);
        const pu = rows[r - 1].find((x) => x.ids.some((i) => ps.includes(i)));
        if (pu) { u.parent = pu; break; }
      }
    }
  }

  let trimmed = false;
  for (const row of rows) if (row.length > MAX_UNITS) { row.length = MAX_UNITS; trimmed = true; }
  return { rows, trimmed };
}

// ---------- Çizim yardımcıları ----------
function fit(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}

function heart(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy + s * 0.9);
  ctx.bezierCurveTo(cx - s * 1.6, cy - s * 0.1, cx - s * 0.7, cy - s * 1.2, cx, cy - s * 0.4);
  ctx.bezierCurveTo(cx + s * 0.7, cy - s * 1.2, cx + s * 1.6, cy - s * 0.1, cx, cy + s * 0.9);
  ctx.closePath();
  ctx.fillStyle = PINK;
  ctx.fill();
}

const hue = (id) => [...String(id)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

async function loadAvatar(url) {
  if (!url) return null;
  try {
    return await Promise.race([
      loadImage(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('zaman aşımı')), 4000)),
    ]);
  } catch { return null; }
}

function drawCard(ctx, x, y, id, info, img, isRoot) {
  ctx.beginPath();
  ctx.roundRect(x, y, CARD_W, CARD_H, 14);
  ctx.fillStyle = '#2b2d3c';
  ctx.fill();
  ctx.lineWidth = isRoot ? 3 : 1.5;
  ctx.strokeStyle = isRoot ? PINK : '#40435a';
  ctx.stroke();

  const cx = x + 14 + AV / 2, cy = y + CARD_H / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, AV / 2, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    ctx.drawImage(img, cx - AV / 2, cy - AV / 2, AV, AV);
  } else {
    ctx.fillStyle = `hsl(${hue(id)}, 55%, 45%)`;
    ctx.fillRect(cx - AV / 2, cy - AV / 2, AV, AV);
    ctx.fillStyle = '#fff';
    ctx.font = `bold 22px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText((info.name || '?').slice(0, 1).toUpperCase(), cx, cy + 1);
  }
  ctx.restore();

  ctx.fillStyle = '#ffffff';
  ctx.font = `600 16px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fit(ctx, info.name || 'Bilinmeyen', CARD_W - AV - 38), x + 14 + AV + 10, cy);
}

// ---------- Ana fonksiyon ----------
// api: { parentsOf, childrenOf, kidsOf, resolve(id) -> {name, avatar} }
async function renderTree(g, root, api) {
  const { rows, trimmed } = buildRows(g, root, api);

  // kullanıcı bilgileri ve avatarlar
  const ids = [...new Set(rows.flatMap((r) => r.flatMap((u) => u.ids)))];
  const infos = new Map(), imgs = new Map();
  await Promise.all(ids.map(async (id) => {
    const info = (await api.resolve(id)) || { name: 'Bilinmeyen', avatar: null };
    infos.set(id, info);
    imgs.set(id, await loadAvatar(info.avatar));
  }));

  // ölçüler
  const unitW = (u) => u.ids.length * CARD_W + (u.ids.length - 1) * COUPLE_GAP;
  const rowW = (row) => row.reduce((a, u) => a + unitW(u), 0) + UNIT_GAP * (row.length - 1);
  const W = Math.max(640, Math.max(...rows.map(rowW)) + PAD * 2);
  const H = TITLE_H + PAD + rows.length * CARD_H + (rows.length - 1) * ROW_GAP + PAD + (trimmed ? 20 : 0);

  rows.forEach((row, r) => {
    let x = (W - rowW(row)) / 2;
    const y = TITLE_H + PAD + r * (CARD_H + ROW_GAP);
    for (const u of row) { u.x = x; u.y = y; u.w = unitW(u); x += u.w + UNIT_GAP; }
  });

  const canvas = createCanvas(Math.ceil(W), Math.ceil(H));
  const ctx = canvas.getContext('2d');

  // arka plan
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1b1c28');
  bg.addColorStop(1, '#262033');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // başlık
    // başlık
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 28px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Aile Ağacı', W / 2, api.sinceText ? 34 : TITLE_H / 2 + 6);

  // alt başlık: evlilik tarihi
  if (api.sinceText) {
    ctx.fillStyle = PINK;
    ctx.font = `15px ${FONT}`;
    ctx.fillText(api.sinceText, W / 2, 62);
  }

  // bağlantı çizgileri
  ctx.strokeStyle = '#6b6f8f';
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  for (let r = 1; r < rows.length; r++) {
    for (const u of rows[r]) {
      const p = u.parent;
      if (!p) continue;
      const x1 = p.x + p.w / 2, y1 = p.y + CARD_H;
      const x2 = u.x + u.w / 2, y2 = u.y;
      const ym = (y1 + y2) / 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1, ym);
      ctx.lineTo(x2, ym);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }

  // kartlar ve kalpler
  for (const row of rows) {
    for (const u of row) {
      u.ids.forEach((id, i) => {
        drawCard(ctx, u.x + i * (CARD_W + COUPLE_GAP), u.y, id, infos.get(id), imgs.get(id), id === root);
      });
      if (u.ids.length === 2) heart(ctx, u.x + CARD_W + COUPLE_GAP / 2, u.y + CARD_H / 2, 8);
    }
  }

  if (trimmed) {
    ctx.fillStyle = '#9a9db8';
    ctx.font = `13px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`Kalabalık satırlar ${MAX_UNITS} kişiyle sınırlandı`, W / 2, H - 18);
  }

  return canvas.toBuffer('image/png');
}

module.exports = { renderTree };
