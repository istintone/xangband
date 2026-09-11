/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* _setup.js — ヘッドレステスト用のロード。
 *
 * index.dev.html の <script data-layer="rule"> を順に読み、共有スコープで評価する
 * ([[D-23]] — 結合順のリストをここに複製しない)。
 * shell 層 (DOM を触る) は読まない。rule 層が DOM 非依存であることは
 * tools/check_code.js の K-2 が保証している。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

function ruleScripts() {
  const dev = fs.readFileSync(path.join(ROOT, 'index.dev.html'), 'utf8');
  const m = /<!-- BUILD:JS -->([\s\S]*?)<!-- \/BUILD:JS -->/.exec(dev);
  if (!m) throw new Error('index.dev.html に BUILD:JS ブロックが無い');
  const out = [];
  for (const tag of m[1].matchAll(/<script[^>]*>\s*<\/script>/g)) {
    const src = /src="([^"]+)"/.exec(tag[0]);
    const layer = /data-layer="([^"]+)"/.exec(tag[0]);
    if (src && layer && layer[1] === 'rule') out.push(src[1]);
  }
  return out;
}

/** rule 層を評価した共有コンテキストを返す。 */
function load() {
  const ctx = vm.createContext({ console, Math, JSON, Date, Error, Array, Object, String, Number });
  for (const rel of ruleScripts()) {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    vm.runInContext(code, ctx, { filename: rel });
  }
  return ctx;
}

module.exports = { load, ruleScripts, ROOT };
