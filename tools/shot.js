#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * 画面のスクリーンショットを撮る。ヘッドレスの Chrome / Edge を使う。
 *
 *   node tools/shot.js                        既定の一式を撮る
 *   node tools/shot.js --out D:\tmp           出力先を指定
 *   node tools/shot.js --size 1280x720        画面サイズ
 *   node tools/shot.js --url "?seed=x&lin=voidborn&role=ghost"
 *
 * **なぜ要るか**: M0〜M3a の間、描画はグリフバッファ段階でしかテストできず、
 * 実際のレイアウトが崩れていても気づけなかった。実際 `fit()` に
 * 「端末が18%縦にはみ出す」バグが残っていた ([[D-58]])。
 * 数値のテストでは見えない種類の不具合があるので、目で見る手段を用意する。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 ? argv[i + 1] : def;
};

/* ブラウザを探す。どちらも Chromium 系なので同じ引数で動く。 */
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
];

function findBrowser() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
}

/* 撮る画面の一式。増やすときはここに足す。 */
const SHOTS = [
  { name: 'create', url: '', size: '1600x900', note: 'キャラクター作成' },
  { name: 'play', url: '?seed=shot&lin=terran&role=marine', size: '1600x900', note: '通常プレイ' },
  { name: 'narrow', url: '?seed=shot&lin=voidborn&role=marksman', size: '1280x720', note: '狭い画面' },
  { name: 'stacked', url: '?seed=shot&lin=terran&role=psion', size: '1000x900', note: '縦積みレイアウト' },
  // 終端 (docs/07 §7.4)。開発用起動でしか行けないので、ここでしか目視できない
  { name: 'still', url: '?seed=shot&dev=depth:98,adapt:all,gear:deep,god:1',
    size: '1600x900', note: '深度98 静止層' },
  { name: 'warden', url: '?seed=shot&dev=depth:99,adapt:all,gear:deep,god:1',
    size: '1600x900', note: '深度99 《門番》' },
  { name: 'origin', url: '?seed=shot&dev=depth:100,adapt:all,gear:deep,god:1',
    size: '1600x900', note: '深度100 《起源》' },
  // 電脳層 (docs/11)。端末のある尖塔で撮る
  { name: 'net', url: '?seed=shot&lin=terran&role=netrunner&dev=depth:25,site:spire,gear:deep',
    size: '1600x900', note: '尖塔 (接続者)' },
  // 表示設定 (docs/09 §9.9)。配色の差は目でしか確かめられない
  { name: 'theme-deuter', url: '?seed=shot&lin=terran&role=marine&theme=deuter',
    size: '1600x900', note: '色覚配慮パレット' },
  { name: 'theme-contrast', url: '?seed=shot&lin=terran&role=marine&theme=contrast&scale=large',
    size: '1600x900', note: '高コントラスト + 文字大' },
  // 表示量の3段 (docs/09 §9.16)。消せることは目で見ないと確かめられない
  { name: 'panels-slim', url: '?seed=shot&lin=terran&role=marine&panels=slim',
    size: '1600x900', note: '簡易 (ガイドと履歴だけ)' },
  { name: 'panels-bare', url: '?seed=shot&lin=terran&role=marine&panels=bare',
    size: '1600x900', note: '非表示 (端末だけ)' },
  // 携帯・タブレット (docs/09 §9.20)。指で遊べるかは目でしか確かめられない
  /* ★Windows のヘッドレスは**ウィンドウを幅500px 未満にできない**。
     390 を指定しても CSS の幅は 500 のままで、画像だけが 390 に切れる
     ―― レイアウトが壊れているように見えるが、写っていないだけ。
     実機の縦画面(390)はここでは再現できないので、
     端末の桁数とサイドバーの判断は src/tests/run.js が数値で検査している。 */
  { name: 'phone', url: '?seed=shot&lin=terran&role=marine',
    size: '500x844', note: '縦長 (これがヘッドレスの最小幅)' },
  { name: 'phone-land', url: '?seed=shot&lin=terran&role=marine',
    size: '844x390', note: 'スマホ 横' },
  { name: 'tablet', url: '?seed=shot&lin=terran&role=marine',
    size: '820x1180', note: 'タブレット 縦' },
  { name: 'tablet-full', url: '?seed=shot&lin=terran&role=marine&panels=full',
    size: '820x1180', note: 'タブレット 縦 (全表示)' }
];

function shoot(browser, outDir, name, url, size) {
  const file = path.join(outDir, name + '.png');
  const r = spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars',
    /* CSS ピクセルとウィンドウの実寸を1:1にする。
       これが無いと 390x844 を指定しても CSS 幅が 492 になり、
       携帯のレイアウトを確かめたつもりでタブレット相当を見ることになる。 */
    '--force-device-scale-factor=1',
    '--virtual-time-budget=3000',
    '--window-size=' + size.replace('x', ','),
    '--screenshot=' + file,
    'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/') + url
  ], { encoding: 'utf8', timeout: 60000 });

  const ok = fs.existsSync(file) && fs.statSync(file).size > 0;
  return { ok, file, size: ok ? fs.statSync(file).size : 0, err: r.stderr };
}

/* ---------- 実行 ---------- */

const browser = findBrowser();
if (!browser) {
  console.log('ブラウザが見つからない。Chrome か Edge が要る。');
  console.log('探した場所:');
  for (const p of CANDIDATES) console.log('  ' + p);
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.log('index.html が無い。python build.py を実行すること。');
  process.exit(1);
}

const outDir = arg('out', path.join(ROOT, 'shots'));
fs.mkdirSync(outDir, { recursive: true });

console.log('browser: ' + path.basename(browser));
console.log('out:     ' + outDir);
console.log('');

const only = arg('url', null);
const list = only
  ? [{ name: 'custom', url: only, size: arg('size', '1600x900'), note: '指定' }]
  : SHOTS.map(s => Object.assign({}, s, { size: arg('size', s.size) }));

let fail = 0;
for (const s of list) {
  const r = shoot(browser, outDir, s.name, s.url, s.size);
  if (r.ok) {
    console.log(`  ok   ${s.name.padEnd(8)} ${s.size.padEnd(9)} ${(r.size / 1024).toFixed(0)}KB  ${s.note}`);
  } else {
    fail++;
    console.log(`  FAIL ${s.name.padEnd(8)} ${s.size.padEnd(9)} ${s.note}`);
    if (r.err) console.log('       ' + r.err.trim().split('\n').slice(-2).join('\n       '));
  }
}

console.log('');
console.log(`${list.length - fail} ok / ${fail} fail`);
console.log('撮った画像を目で確認すること。数値のテストでは見えない不具合がある。');
process.exit(fail ? 1 : 0);
