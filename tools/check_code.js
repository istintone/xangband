#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * コードの不変条件検査 (docs/01 §1.5)
 *
 *   node tools/check_code.js
 *
 * 検査対象と層は index.dev.html から読む ([[D-23]])。リストを二重に持たない。
 *
 *   K-1  Math.random() を使っていない            (不変条件 1)
 *   K-2  rule 層が DOM / ブラウザ API を触らない  (不変条件 3)
 *   K-3  生の #rrggbb がパレット以外に無い        ([[D-24]])
 *   K-4  index.dev.html の参照先が実在し、boot.js が最後にある
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(p, 'utf8');

const results = [];
let cur = null;
const check = (id, title) => { cur = { id, title, notes: [], fail: false }; results.push(cur); };
const fail = m => { cur.fail = true; cur.notes.push('FAIL: ' + m); };
const note = m => cur.notes.push(m);

/** コメントと文字列リテラルを空白に潰す。行数と桁数は保つ。 */
function stripNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const blank = s => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? n : e + 2;
      out += blank(src.slice(i, end)); i = end;
    } else if (c === '/' && d === '/') {
      let e = src.indexOf('\n', i);
      if (e === -1) e = n;
      out += blank(src.slice(i, e)); i = e;
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += blank(src.slice(i, Math.min(j + 1, n))); i = j + 1;
    } else {
      out += c; i++;
    }
  }
  return out;
}

/** index.dev.html から (path, layer) を順に読む。build.py と同じ書式を前提にする。 */
function parseScripts() {
  const dev = read(path.join(ROOT, 'index.dev.html'));
  const m = /<!-- BUILD:JS -->([\s\S]*?)<!-- \/BUILD:JS -->/.exec(dev);
  if (!m) throw new Error('index.dev.html に BUILD:JS ブロックが無い');
  const out = [];
  for (const tag of m[1].matchAll(/<script[^>]*>\s*<\/script>/g)) {
    const src = /src="([^"]+)"/.exec(tag[0]);
    if (!src) continue;
    const layer = /data-layer="([^"]+)"/.exec(tag[0]);
    out.push({ src: src[1], layer: layer ? layer[1] : 'shell' });
  }
  return out;
}

const scripts = parseScripts();
const sources = scripts.map(s => {
  const p = path.join(ROOT, s.src);
  const exists = fs.existsSync(p);
  return Object.assign({}, s, { path: p, exists, code: exists ? stripNonCode(read(p)) : '' });
});

/** 行ごとに正規表現を当てて、当たった行を報告する。 */
function scan(s, re, report) {
  s.code.split('\n').forEach((line, i) => {
    re.lastIndex = 0;
    if (re.test(line)) report(s.src + ':' + (i + 1) + '  ' + line.trim().slice(0, 70));
  });
}

// ============ K-4: 参照の健全性 ============
check('K-4', 'index.dev.html の参照先が実在し boot.js が最後');
{
  for (const s of sources) if (!s.exists) fail('参照先が無い: ' + s.src);
  const last = scripts[scripts.length - 1];
  if (!last || !/boot\.js$/.test(last.src)) {
    fail('boot.js が最後にない (起動の副作用を持つため必ず最後: docs/01 §1.2)');
  }
  const css = /<!-- BUILD:CSS -->([\s\S]*?)<!-- \/BUILD:CSS -->/.exec(read(path.join(ROOT, 'index.dev.html')));
  if (css) {
    for (const m of css[1].matchAll(/href="([^"]+)"/g)) {
      if (!fs.existsSync(path.join(ROOT, m[1]))) fail('CSS の参照先が無い: ' + m[1]);
    }
  }
  note(scripts.length + ' files (rule ' + scripts.filter(s => s.layer === 'rule').length +
       ' / shell ' + scripts.filter(s => s.layer === 'shell').length + ')');
}

// ============ K-1: Math.random 禁止 ============
check('K-1', 'Math.random() を使っていない');
{
  for (const s of sources) {
    scan(s, /Math\s*\.\s*random/, m => fail(m + '   -> RNG.create(seed) を使うこと'));
  }
  note('全 ' + sources.length + ' ファイルを検査');
}

// ============ K-2: rule 層の DOM 非依存 ============
check('K-2', 'rule 層が DOM / ブラウザ API を触らない');
{
  const BANNED = /\b(document|window|navigator|localStorage|sessionStorage|requestAnimationFrame|alert|fetch|XMLHttpRequest)\b/;
  const ruleFiles = sources.filter(s => s.layer === 'rule');
  for (const s of ruleFiles) {
    s.code.split('\n').forEach((line, i) => {
      // Node/ブラウザ両対応のエクスポート行だけは許可する
      if (/typeof\s+module/.test(line)) return;
      const m = BANNED.exec(line);
      if (m) fail(s.src + ':' + (i + 1) + '  ' + m[1] + ' を参照している -> shell 層へ移すこと');
    });
  }
  note('rule 層 ' + ruleFiles.length + ' ファイル');
}

// ============ K-3: 生の色コード ============
check('K-3', '生の #rrggbb がパレット以外に無い');
{
  for (const s of sources) {
    if (/render\.js$/.test(s.src)) continue;   // パレット定義そのもの
    scan(s, /#[0-9a-fA-F]{3,8}\b/, m => fail(m + '   -> Render.PALETTE に色名で登録すること'));
  }
  note('render.js (パレット定義) を除外して検査');
}

// ---------- 出力 ----------
let failed = 0;
for (const r of results) {
  if (r.fail) failed++;
  console.log('[' + (r.fail ? 'FAIL' : 'PASS') + '] ' + (r.id + '    ').slice(0, 4) + ' ' + r.title);
  for (const n of r.notes) console.log('        - ' + n);
}
console.log('');
console.log((results.length - failed) + ' pass / ' + failed + ' fail');
process.exit(failed ? 1 : 0);
