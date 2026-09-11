#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * 描画の検査。ヘッドレスのブラウザで実際に描いて確かめる ([[D-59]])。
 *
 *   node tools/check_render.js
 *
 * R-1 差分描画の残像 … 変わったセルだけ塗り直す方式なので、
 *     セル境界が device pixel の小数に落ちると継ぎ目に前の文字の縁が残る。
 *     **devicePixelRatio を変えて検査する**のが要点。dpr=1 では絶対に出ない。
 * R-2 端末が領域に収まる … 縦にはみ出して下端が切れていないか。
 *
 * ヘッドレスのスクリーンショットを目で見るだけでは、
 * この種の1px単位の不具合は見つけられない。ピクセル単位で比較する。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
];
const browser = CANDIDATES.find(p => fs.existsSync(p));

/* 検査する devicePixelRatio。**小数を必ず含めること。**
   整数倍率だけだと境界がたまたま整数に落ちて、不具合を見逃す。 */
const RATIOS = [1, 1.25, 1.5, 1.75, 2, 2.5];

/** 検査ページ。src/js を直接読むので、ビルド前でも動く。 */
function buildPage() {
  const scripts = (() => {
    const dev = fs.readFileSync(path.join(ROOT, 'index.dev.html'), 'utf8');
    const m = /<!-- BUILD:JS -->([\s\S]*?)<!-- \/BUILD:JS -->/.exec(dev);
    const out = [];
    for (const tag of m[1].matchAll(/<script[^>]*src="([^"]+)"[^>]*>\s*<\/script>/g)) {
      // 起動の副作用を持つものは読まない
      if (/boot\.js$/.test(tag[1])) continue;
      out.push('<script src="' + tag[1] + '"></script>');
    }
    return out.join('\n');
  })();

  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>checking</title>
<style>.stage{width:800px;height:800px;position:absolute;left:-9999px}</style>
</head><body>
<div class="stage"><canvas id="a"></canvas></div>
<div class="stage"><canvas id="b"></canvas></div>
${scripts}
<script>
/* ★複数行の場合を必ず入れる。
   「上の行は変わらず、下の行だけ変わる」ときに、
   下の文字のインクが上のセルへはみ出していると、そこは塗り直されず残る。
   1行だけの検査ではこれを見逃す。 */
var CASES = [
  { n: '全角の一部だけ差し替え', a: ['固定地球系人類固定'], b: ['固定重力適応体固定'] },
  { n: '説明文が別の文言に変わる', a: ['断絶前と変わらない身体。'], b: ['高重力環境で生まれ育った。'] },
  { n: '枠の中を1マスだけ空白に', a: ['｜壱｜弐｜参｜'], b: ['｜壱｜　｜参｜'] },
  { n: '半角の一部だけ差し替え', a: ['MMMMMMMMMM'], b: ['MMMMXMMMMM'] },
  { n: '全角→半角 (幅が変わる)', a: ['あああああ'], b: ['aaaaaaaaaa'] },
  { n: '色だけ変わる', a: ['同じ文字'], b: ['同じ文字'], fgB: 'red' },

  { n: '上の行は不変・下の行が変わる',
    a: ['拡張知性', '動物由来の知性化個体。嗅覚が残って'],
    b: ['拡張知性', '高重力環境で生まれ育った。重い装備'] },
  { n: '下の行は不変・上の行が変わる',
    a: ['地球系人類', '同じ説明がずっと続く行'],
    b: ['義体化人類', '同じ説明がずっと続く行'] },
  { n: '真ん中の行だけ変わる (上下は不変)',
    a: ['上の行はそのまま', '真ん中が変わる行', '下の行もそのまま'],
    b: ['上の行はそのまま', '別の文字に差し替え', '下の行もそのまま'] },
  { n: '記号と括弧が並ぶ行の一部',
    a: ['｜壱｜', '（能力値補正）', '体力+3 演算-1'],
    b: ['｜壱｜', '（能力値補正）', '体力±0 演算+2'] }
];
function frame(rows, fg) {
  var buf = Render.createBuffer(Render.TERM.w, Render.TERM.h);
  for (var y = 0; y < rows.length; y++) Render.text(buf, 0, y, rows[y], fg || 'white', 'black');
  return buf;
}
function pixels(id, frames) {
  var el = document.getElementById(id);
  Term.init(el);                       // init は prev を捨てる = 一から描く
  for (var i = 0; i < frames.length; i++) Term.draw(frames[i]);
  return el.getContext('2d').getImageData(0, 0, el.width, el.height).data;
}
var results = [], bad = 0;
for (var c = 0; c < CASES.length; c++) {
  var t = CASES[c];
  var fa = frame(t.a), fb = frame(t.b, t.fgB);
  var diffDraw = pixels('a', [fa, fb]);
  var fresh = pixels('b', [fb]);
  var n = 0;
  for (var i = 0; i < diffDraw.length; i += 4) {
    if (diffDraw[i] !== fresh[i] || diffDraw[i+1] !== fresh[i+1] || diffDraw[i+2] !== fresh[i+2]) n++;
  }
  if (n > 0) bad++;
  results.push({ n: t.n, px: n });
}
// 端末が領域に収まっているか
var el = document.getElementById('a');
var stage = el.parentElement;
var fits = el.getBoundingClientRect().height <= stage.clientHeight + 1 &&
           el.getBoundingClientRect().width <= stage.clientWidth + 1;
document.title = 'RESULT:' + JSON.stringify({
  dpr: window.devicePixelRatio || 1, bad: bad, fits: fits, results: results
});
</script></body></html>`;
}

/* ---------- 実行 ---------- */

if (!browser) {
  console.log('SKIP: ブラウザが無いので描画検査を飛ばす (Chrome か Edge が要る)');
  process.exit(0);
}

const page = path.join(ROOT, '_check_render.html');
fs.writeFileSync(page, buildPage(), 'utf8');

let failed = 0;
console.log('[描画検査] browser: ' + path.basename(browser));

try {
  for (const dpr of RATIOS) {
    const r = spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--force-device-scale-factor=' + dpr,
      '--virtual-time-budget=5000', '--window-size=900,400',
      '--dump-dom', 'file:///' + page.replace(/\\/g, '/')
    ], { encoding: 'utf8', timeout: 90000, maxBuffer: 64 * 1024 * 1024 });

    const m = /<title>RESULT:(.*?)<\/title>/.exec(r.stdout || '');
    if (!m) {
      failed++;
      console.log(`  FAIL dpr=${String(dpr).padEnd(5)} 結果を取得できなかった`);
      continue;
    }
    let data;
    try { data = JSON.parse(m[1].replace(/&quot;/g, '"')); }
    catch (e) { failed++; console.log(`  FAIL dpr=${dpr} 結果が壊れている`); continue; }

    const ghosts = data.results.filter(x => x.px > 0);
    const ok = ghosts.length === 0 && data.fits;
    if (!ok) failed++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} dpr=${String(dpr).padEnd(5)}` +
                (ghosts.length ? '  残像: ' + ghosts.map(g => `${g.n}(${g.px}px)`).join(', ') : '') +
                (data.fits ? '' : '  端末が領域からはみ出している'));
  }
} finally {
  fs.unlinkSync(page);
}

console.log('');
console.log(`${RATIOS.length - failed} pass / ${failed} fail`);
if (failed) {
  console.log('※ 差分描画の残像は **devicePixelRatio が小数のとき**に出る。');
  console.log('  セル寸法を device pixel の整数で決めているか確認すること ([[D-59]])。');
}
process.exit(failed ? 1 : 0);
