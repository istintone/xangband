#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * 枠外UI (panel.js) の検証。shell 層なので、最小限の DOM スタブで動かす。
 *
 *   node src/tests/panel.js
 *
 * ブラウザが無い環境でも「DOM を組み立てる経路が落ちないか」
 * 「ボタンがコマンドを正しく発行するか」までは確かめられる。
 * 見た目そのものは確認できない ― そこは実際に開いて見る必要がある。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { load, ROOT } = require('./_setup');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}
function eq(a, b, m) {
  if (a !== b) throw new Error((m || '') + ' 期待 ' + JSON.stringify(b) + ' / 実際 ' + JSON.stringify(a));
}
function ok(c, m) { if (!c) throw new Error(m || '条件を満たさない'); }

/* ---------- 最小 DOM スタブ ---------- */

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    className: '', textContent: '', type: '', disabled: false,
    children: [], dataset: {}, style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
      toggle(c, force) {
        const want = force === undefined ? !this._set.has(c) : !!force;
        if (want) this._set.add(c); else this._set.delete(c);
        return want;
      }
    },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    addEventListener(type, fn) { (this._handlers ||= {})[type] = fn; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      // '.cls' と '.cls[data-x]' だけ対応すれば足りる
      const m = /^\.([\w-]+)(?:\[data-([\w-]+)\])?$/.exec(sel);
      const out = [];
      (function walk(node) {
        for (const c of node.children) {
          if (m) {
            const hasCls = c.className.split(/\s+/).includes(m[1]) || c.classList.contains(m[1]);
            const hasAttr = !m[2] || c.dataset[m[2]] !== undefined;
            if (hasCls && hasAttr) out.push(c);
          }
          walk(c);
        }
      })(this);
      return out;
    },
    get innerHTML() { return ''; },
    set innerHTML(v) { if (v === '') this.children.length = 0; }
  };
  Object.defineProperty(el, 'closest', {
    value(sel) {
      const cls = sel.replace(/^\./, '');
      let n = el;
      while (n) {
        if (n.className && n.className.split(/\s+/).includes(cls)) return n;
        n = n.parent;
      }
      return null;
    }
  });
  return el;
}

/* ---------- rule 層 + panel.js を読む ---------- */

const ctx = load();
ctx.Data.init(ctx.RAW);
ctx.document = {
  createElement: makeElement,
  createTextNode: (s) => ({ nodeValue: String(s), children: [], className: '' })
};

/* localStorage と documentElement のスタブ。theme.js が触る最小限だけ。 */
const store = {};
ctx.localStorage = {
  getItem(k) { return k in store ? store[k] : null; },
  setItem(k, v) { store[k] = String(v); },
  removeItem(k) { delete store[k]; }
};
ctx.document.documentElement = { style: { _v: {}, setProperty(k, v) { this._v[k] = v; } } };

for (const f of ['panel.js', 'theme.js', 'ui.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src', 'js', f), 'utf8'),
                  ctx, { filename: 'src/js/' + f });
}
const { Panel, Cmd, Legend, World, Monster, Data, Env, Theme, Render, Sigil,
        Item, Inventory, RNG, UI } = ctx;

/* ---------- 検証 ---------- */

console.log('\n[枠外UI panel.js]');

const cmdEl = makeElement('aside');
const legendEl = makeElement('aside');
const guideEl = makeElement('section');
const logEl = makeElement('section');
const sent = [];
Panel.init({ commands: cmdEl, legend: legendEl, guide: guideEl, log: logEl },
           cmd => sent.push(cmd));

t('操作パネルが組み立てられる', () => {
  ok(cmdEl.children.length > 0, 'パネルが空');
  const buttons = cmdEl.querySelectorAll('.p-cmd');
  ok(buttons.length >= 20, 'ボタンが少なすぎる: ' + buttons.length);
});

t('すべての分類が出ている', () => {
  const names = Panel.GROUPS.map(g => g.name);
  eq(names.length, 6, '分類の数');
  for (const n of ['移動', '戦う', '調べる', '持ち物', '進む', 'システム']) {
    ok(names.includes(n), n + ' が無い');
  }
});

t('ボタンのコマンドが cmd.js / boot の受け口と一致する', () => {
  /* Panel が発行するコマンド型が、実際に処理される型かを確かめる。
     受け口の一覧を**ソースから読む**。手で並べると必ずズレる
     ―― 実際 M4b で `service` を足したときに落ちた。 */
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..', '..');
  const known = new Set();
  for (const f of ['src/js/boot.js', 'src/js/cmd.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/case '([a-zA-Z]+)':/g)) known.add(m[1]);
  }
  ok(known.size > 10, '受け口を読み出せていない');
  for (const g of Panel.GROUPS) {
    for (const item of g.items) {
      if (!item.cmd) continue;
      ok(known.has(item.cmd.type),
         '★未知のコマンド型をボタンが発行している: ' + item.cmd.type + ' (' + item.label + ')');
    }
  }
});

t('ボタンのクリックがコマンドを発行する ([[D-57]])', () => {
  const buttons = cmdEl.querySelectorAll('.p-cmd');
  const target = buttons.find(b => b.dataset.cmd && JSON.parse(b.dataset.cmd).type === 'pickup');
  ok(target, '「拾う」ボタンが無い');

  sent.length = 0;
  cmdEl._handlers.click({ target: target });
  eq(sent.length, 1, 'コマンドが発行されなかった');
  eq(sent[0].type, 'pickup', '発行されたコマンドが違う');
});

t('説明だけの行はコマンドを発行しない', () => {
  const infos = cmdEl.querySelectorAll('.p-cmd').filter(b => !b.dataset.cmd);
  ok(infos.length > 0, '説明行が無い');
  sent.length = 0;
  cmdEl._handlers.click({ target: infos[0] });
  eq(sent.length, 0, '押せない行がコマンドを発行した');
});

t('使えないコマンドが淡色になる', () => {
  const W = Cmd.newGame('panel', 'terran', 'marine');   // 射出器なし・能力なし
  Panel.refresh(W);
  const needy = cmdEl.querySelectorAll('.p-cmd[data-need]');
  ok(needy.length >= 2, 'need 付きのボタンが無い');
  ok(needy.every(b => b.classList.contains('p-off')),
     '突撃兵なのに「撃つ」「能力」が有効になっている');

  const W2 = Cmd.newGame('panel2', 'terran', 'marksman'); // 射出器あり
  Panel.refresh(W2);
  const shoot = cmdEl.querySelectorAll('.p-cmd[data-need]')
    .find(b => b.dataset.need === 'launcher');
  ok(!shoot.classList.contains('p-off'), '狙撃手なのに「撃つ」が淡色');
});

t('凡例HUD が組み立てられ、内容が入る', () => {
  const W = Cmd.newGame('panel3');
  const foe = W.actors.find(a => a.kind === 'monster');
  foe.x = W.player.x + 1; foe.y = W.player.y;
  Cmd.refreshView(W);

  Panel.refresh(W);
  const body = legendEl.querySelector('.l-body');
  ok(body, 'l-body が無い');
  ok(body.children.length > 0, '凡例が空');

  // ヒントは中央下部のガイドへ移した ([[D-82]])。HUD には残っていない
  eq(legendEl.querySelectorAll('.l-hint').length, 0, 'HUD にヒントが残っている');
  ok(guideEl.querySelectorAll('.g-hint').length > 0, 'ガイドにヒントが出ていない');
});

t('W が無くても凡例が落ちない (作成画面)', () => {
  Panel.refresh(null);
  const body = legendEl.querySelector('.l-body');
  ok(body, 'l-body が消えた');
  ok(body.children.length > 0, '案内文すら出ていない');
});

t('危険な状況では danger のヒントが出る', () => {
  const W = Cmd.newGame('panel4');
  W.level.env = Env.create({ atmosphere: 0 });
  W.inv.equip.body = null;
  Cmd.recalc(W);
  Panel.refresh(W);
  const danger = guideEl.querySelectorAll('.l-danger');
  ok(danger.length > 0, '気密不足なのに danger のヒントが無い');
});

console.log('\n[中央下部 ガイドと履歴 (docs/09 §9.16)]');

t('ガイドは HUD から独立している ([[D-82]])', () => {
  const W = Cmd.newGame('guide');
  Panel.refresh(W);
  ok(guideEl.querySelector('.g-body'), 'ガイドの本体が無い');
  // 性質が違うものを同じ場所に置かない
  eq(legendEl.querySelectorAll('.g-hint').length, 0, 'HUD 側にガイドが混ざっている');
});

t('ガイドの行動は押せる ([[D-85]])', () => {
  /* 「助言を出しているのに押せない」のが元の問題だった。
     押したらキー入力と同じ経路を通ること ([[D-57]]) も確かめる。 */
  const W = Cmd.newGame('guide-act');
  Cmd.enterLevel(W, 3, false);
  W.player.x = W.level.down.x; W.player.y = W.level.down.y;
  Cmd.refreshView(W);
  Panel.refresh(W);

  const buttons = guideEl.querySelectorAll('.g-act');
  ok(buttons.length > 0, 'ガイドに押せる行動が無い');
  ok(buttons.every(b => b.dataset.cmd), 'コマンドを持たないボタンがある');

  sent.length = 0;
  guideEl._handlers.click({ target: buttons[0] });
  eq(sent.length, 1, '押してもコマンドが発行されない');
  ok(sent[0].type, '発行されたコマンドに型が無い');
});

t('メッセージ履歴が端末より長く遡れる', () => {
  const W = Cmd.newGame('log');
  for (let i = 0; i < 30; i++) World.msg(W, 'メッセージ ' + i);
  Panel.refresh(W);
  const rows = logEl.querySelectorAll('.m-row');
  ok(rows.length > Render.MSG_ROWS,
     '端末の ' + Render.MSG_ROWS + ' 行より多く出ていない: ' + rows.length);
  ok(rows.length <= Panel.LOG_MAX, '上限を超えて溜めている: ' + rows.length);
  // 最新の行が分かる
  ok(logEl.querySelectorAll('.m-new').length === 1, '最新の行が示されていない');
});

t('同じメッセージの連続は回数でまとまる', () => {
  const W = Cmd.newGame('log2');
  for (let i = 0; i < 5; i++) World.msg(W, '同じこと');
  Panel.refresh(W);
  ok(logEl.querySelectorAll('.m-count').length > 0, '回数が出ていない');
});

t('表示量が3段で回る ([[D-83]])', () => {
  const app = makeElement('div');
  const label = makeElement('button');

  eq(Panel.setMode(app, label, 'full').id, 'full', '全表示にできない');
  eq(app.classList.contains('ui-slim'), false, '全表示なのに簡易の印が付いている');
  eq(app.classList.contains('ui-bare'), false, '全表示なのに非表示の印が付いている');

  eq(Panel.cycleMode(app, label).id, 'slim', '次が簡易でない');
  eq(app.classList.contains('ui-slim'), true, '簡易の印が付かない');

  eq(Panel.cycleMode(app, label).id, 'bare', '次が非表示でない');
  eq(app.classList.contains('ui-bare'), true, '非表示の印が付かない');
  eq(app.classList.contains('ui-slim'), false, '前の段の印が残っている');

  eq(Panel.cycleMode(app, label).id, 'full', '一周して全表示に戻らない');
  ok(label.textContent.indexOf('全表示') !== -1, 'ボタンの表示が更新されない');
});

t('枠外を全部消しても、端末にメッセージが残る ([[D-83]])', () => {
  /* 全部消しても遊べなければ、消す選択肢は選択肢にならない。
     端末内のメッセージ行を消していないことを確かめる。 */
  ok(Render.MSG_ROWS >= 1, '端末にメッセージ行が無い');
  const W = Cmd.newGame('bare');
  World.msg(W, 'これは端末に出る');
  const buf = Render.frame(W);
  let line = '';
  for (let x = 0; x < 80; x++) {
    const c = buf.cells[x];
    if (c && c.w !== 0) line += c.ch || ' ';
  }
  ok(line.indexOf('これは端末に出る') !== -1, '端末の1行目にメッセージが出ていない');
});

console.log('\n[一覧のカーソル (docs/09 §9.21)]');

t('開くたびに先頭から始まる ([[D-88]])', () => {
  const W = Cmd.newGame('cur1');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  UI.open('act');
  eq(UI.cursorAt(), 0, '開いた直後が先頭でない');

  const n = UI.listFor(W, 'act').length;
  ok(n > 0, 'テスト前提: 行動が無い');
  UI.moveCursor(1, n);
  UI.open('act');
  eq(UI.cursorAt(), 0, '開き直しても前の位置が残っている');
});

t('カーソルは端で止まる ―― 回り込ませない', () => {
  /* 回り込むと、行き過ぎたことに気づけない。
     一覧は短いので、端で止まるほうが位置を見失わない。 */
  const W = Cmd.newGame('cur2');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  UI.open('act');
  const n = UI.listFor(W, 'act').length;
  if (n < 2) return;

  UI.moveCursor(-1, n);
  eq(UI.cursorAt(), 0, '先頭より上へ動いた');
  UI.moveCursor(999, n);
  eq(UI.cursorAt(), n - 1, '末尾へ飛べない');
  UI.moveCursor(1, n);
  eq(UI.cursorAt(), n - 1, '末尾より下へ動いた');
});

t('空の一覧でも落ちない', () => {
  const W = Cmd.newGame('cur3');
  UI.open('act');
  UI.moveCursor(1, 0);
  eq(UI.cursorAt(), 0, '空なのにカーソルが動いた');
  UI.setCursor(5, 0);
  eq(UI.cursorAt(), 0, '空なのに位置が付いた');
});

t('カーソル行が画面で分かる ―― 色だけに頼らない ([[D-52]])', () => {
  const W = Cmd.newGame('cur4');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  UI.open('act');
  const n = UI.listFor(W, 'act').length;
  if (n < 2) return;

  function markerRows(buf) {
    const cols = Render.TERM.w;
    const rows = [];
    for (let y = 0; y < Render.TERM.h; y++) {
      for (let x = 0; x < cols; x++) {
        const c = buf.cells[y * cols + x];
        if (c && c.ch === '>' && c.fg === 'yellow') { rows.push(y); break; }
      }
    }
    return rows;
  }

  UI.setCursor(0, n);
  const a = markerRows(overlayFrame(W));
  UI.setCursor(1, n);
  const b = markerRows(overlayFrame(W));
  ok(a.length > 0, 'カーソルの印が出ていない');
  ok(b.length > 0, '動かした後に印が出ていない');
  ok(a[0] !== b[0], 'カーソルを動かしても印の位置が変わらない');
});

function overlayFrame(W) {
  const buf = Render.frame(W);
  UI.overlay(buf, W, null);
  return buf;
}

console.log('\n[一覧のタップ (docs/09 §9.22)]');

/** overlay を描いて当たり判定を作る。 */
function overlayFor(W, mode, ctx) {
  UI.open(mode, ctx);
  const buf = Render.frame(W);
  UI.overlay(buf, W, null);
  return buf;
}

/** 一覧の全行が、描いた場所をタップして選べるか。 */
function everyRowHits(W, mode, ctx) {
  overlayFor(W, mode, ctx);
  const n = UI.listFor(W, mode).length;
  const missed = [];
  for (let i = 0; i < n; i++) {
    let found = false;
    // 枠のどこかにその行があるはず。端末全面を走査する
    for (let y = 0; y < Render.TERM.h && !found; y++) {
      for (let x = 0; x < Render.TERM.w; x++) {
        if (UI.hitAt(x, y) === i) { found = true; break; }
      }
    }
    if (!found) missed.push(i);
  }
  return { n: n, missed: missed };
}

t('選択できる一覧は全て、行をタップで選べる ([[D-97]])', () => {
  /* clickMap に `if (UI.isOpen()) return;` があり、オーバーレイ中の
     タップが完全に無視されていた。25画面のうち20が選択画面で、
     携帯では所持品も店も触れなかった。 */
  const W = Cmd.newGame('tap1');
  Cmd.enterLevel(W, 0, false);          // 母船 (店が開ける)
  Cmd.refreshView(W);

  // 中身が要る一覧には物を持たせる
  const db = Data.get();
  for (const id of ['medgel', 'pry-bar']) {
    const kind = db.itemsById[id];
    if (kind) Inventory.add(W.inv, Item.create(W.rng, kind, 2));
  }
  Cmd.recalc(W);

  const modes = ['inventory', 'use', 'wear', 'drop', 'equip', 'site', 'display'];
  for (const m of modes) {
    const r = everyRowHits(W, m);
    if (r.n === 0) continue;            // 空の一覧は対象外
    eq(r.missed.length, 0, m + ' の行 ' + r.missed.join(',') + ' がタップで選べない');
  }
});

t('系統とロールの選択がタップで進む ―― 携帯で開始できる ([[D-97]])', () => {
  /* 起動直後のモードが lineage なので、ここが触れないと
     **ゲームを始めることすらできない**。W がまだ無い時点で開くので、
     当たり判定も W を参照してはいけない。 */
  for (const mode of ['lineage', 'role']) {
    UI.open(mode);
    const buf = Render.frame(null);
    UI.overlay(buf, null, { lineage: null, role: null, hover: 0 });
    const n = UI.listFor(null, mode).length;
    ok(n > 0, mode + ' の選択肢が無い');
    let hit = 0;
    for (let y = 0; y < Render.TERM.h; y++) {
      for (let x = 0; x < Render.TERM.w; x++) if (UI.hitAt(x, y) >= 0) { hit++; break; }
    }
    ok(hit >= n, mode + ' のタップ可能な行が ' + hit + ' しかない (選択肢 ' + n + ')');
  }
});

t('タップした行と、その場に描かれた行が一致する ([[D-51]])', () => {
  /* 当たり判定を描画と別に計算すると、順序がズレる余地ができる。
     カーソルを当たり判定の位置に合わせて、印が動くことで確かめる。 */
  const W = Cmd.newGame('tap2');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  const db = Data.get();
  for (const id of ['medgel', 'pry-bar', 'ration']) {
    const kind = db.itemsById[id];
    if (kind) Inventory.add(W.inv, Item.create(W.rng, kind, 1));
  }

  overlayFor(W, 'inventory');
  const n = UI.listFor(W, 'inventory').length;
  if (n < 2) return;

  // 行 i の当たり判定の位置を集める
  const rowY = [];
  for (let y = 0; y < Render.TERM.h; y++) {
    for (let x = 0; x < Render.TERM.w; x++) {
      const i = UI.hitAt(x, y);
      if (i >= 0 && rowY[i] === undefined) rowY[i] = y;
    }
  }
  for (let i = 1; i < n; i++) {
    ok(rowY[i] > rowY[i - 1],
       '行 ' + i + ' が行 ' + (i - 1) + ' より上にある (描画順と当たり判定がズレている)');
  }
});

t('枠の外と中を見分けられる ―― 外タップで閉じる ([[D-97]])', () => {
  const W = Cmd.newGame('tap3');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  overlayFor(W, 'inventory');

  // 枠の中に必ず1点ある
  let inside = 0, outside = 0;
  for (let y = 0; y < Render.TERM.h; y++) {
    for (let x = 0; x < Render.TERM.w; x++) {
      if (UI.insideFrame(x, y)) inside++; else outside++;
    }
  }
  ok(inside > 0, '枠が記録されていない');
  ok(outside > 0, '画面全部が枠になっている (外タップで閉じられない)');
  eq(UI.insideFrame(0, Render.TERM.h - 1), false, '左下が枠の中と判定された');
});

t('閉じると当たり判定が残らない ([[D-97]])', () => {
  /* 残っていると、閉じた後のマップのタップが一覧の選択として拾われる。 */
  const W = Cmd.newGame('tap4');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  overlayFor(W, 'inventory');

  UI.close();
  const buf = Render.frame(W);
  UI.overlay(buf, W, null);             // 閉じた状態で描き直す
  let any = -1;
  for (let y = 0; y < Render.TERM.h && any < 0; y++) {
    for (let x = 0; x < Render.TERM.w; x++) {
      if (UI.hitAt(x, y) >= 0) { any = y; break; }
    }
  }
  eq(any, -1, '閉じたのに当たり判定が残っている (行 y=' + any + ')');
  eq(UI.insideFrame(5, 5), false, '閉じたのに枠が残っている');
});

console.log('\n[表示設定 theme.js]');

t('配色を切り替えるとパレットが差し替わる (docs/09 §9.9)', () => {
  Theme.init(null);
  const base = Render.PALETTE.green;
  ok(Theme.set('palette', 'deuter'), '色覚配慮パレットに切り替えられない');
  ok(Render.PALETTE.green !== base, 'パレットが変わっていない');

  // 赤と緑が「色相だけ」で分かれていないこと ―― 輝度でも差が出ているか
  const lum = hex => {
    const n = parseInt(hex.slice(1), 16);
    return 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  };
  /* 赤・緑・黄は「危険/良好/警告」を担う。1型/2型では色相が当てにならないので、
     **三つが互いに輝度で分かれている**ことを要求する。 */
  const pairs = [['red', 'green'], ['red', 'yellow'], ['green', 'yellow']];
  for (const [a, b] of pairs) {
    const d = Math.abs(lum(Render.PALETTE[a]) - lum(Render.PALETTE[b]));
    ok(d > 30, '★色覚配慮パレットで ' + a + ' と ' + b + ' の輝度差が小さい: ' + d.toFixed(0));
  }

  Theme.set('palette', 'normal');
  eq(Render.PALETTE.green, base, '標準に戻らない');
});

t('文字サイズが CSS 変数に反映される', () => {
  Theme.init(null);
  Theme.set('scale', 'xlarge');
  const v = parseFloat(ctx.document.documentElement.style._v['--ui-scale']);
  ok(v > 1.3, '--ui-scale が大きくならない: ' + v);
  Theme.set('scale', 'normal');
  eq(parseFloat(ctx.document.documentElement.style._v['--ui-scale']), 1, '標準に戻らない');
});

t('設定が保存され、読み直しても残る', () => {
  Theme.init(null);
  Theme.set('palette', 'contrast');
  Theme.set('scale', 'large');
  // 別セッションのつもりで読み直す
  Theme.load();
  Theme.apply();
  eq(Theme.current().palette, 'contrast', '配色が残らない');
  eq(Theme.current().scale, 'large', '文字サイズが残らない');
  Theme.set('palette', 'normal'); Theme.set('scale', 'normal');
});

t('切り替えは1キーで回せる', () => {
  Theme.init(null);
  const seen = new Set();
  for (let i = 0; i < Theme.palettes().length; i++) {
    seen.add(Theme.current().palette);
    Theme.cycle('palette');
  }
  eq(seen.size, Theme.palettes().length, '全ての配色を回れない');
  eq(Theme.current().palette, 'normal', '一周して戻らない');
});

t('高コントラスト配色では走査線と発光を切る ([[D-82]])', () => {
  // 意匠のために可読性を下げない。この配色を選ぶ人は読みやすさのために選んでいる
  Theme.init(null);
  Theme.set('palette', 'normal');
  ok(parseFloat(ctx.document.documentElement.style._v['--crt']) > 0,
     '標準で意匠が切れている');
  Theme.set('palette', 'contrast');
  eq(parseFloat(ctx.document.documentElement.style._v['--crt']), 0,
     '高コントラストで走査線が残っている');
  Theme.set('palette', 'normal');
});

t('全パレットが同じ色名を揃えている', () => {
  // 欠けている色があると、その配色でだけ描画が黒くなる
  const keys = Object.keys(Theme.PALETTES.normal.colors).sort().join(',');
  for (const id in Theme.PALETTES) {
    eq(Object.keys(Theme.PALETTES[id].colors).sort().join(','), keys,
       id + ' の色名が標準と揃っていない');
  }
});

t('未解析の装備は色でも中身を漏らさない ([[D-78]])', () => {
  /* 一覧が未解析の改修品を青くしていたので、名前が「未解析の〜」でも
     当たりだと分かってしまい、刻印式鑑定 ([[D-06]]) が骨抜きになっていた。 */
  const W = Cmd.newGame('leak');
  const rng = RNG.create('leak');
  let ego = null, plain = null;
  for (let i = 0; i < 4000 && (!ego || !plain); i++) {
    const it = Item.makeForDepth(rng, 20, W);
    if (!it || !it.slot) continue;
    if (it.egoId && !Sigil.fullyKnown(W.knowledge, it)) ego = ego || it;
    if (!it.egoId && !Sigil.fullyKnown(W.knowledge, it)) plain = plain || it;
  }
  if (!ego || !plain) return;                 // 引けなければ判定しない

  const row = ctx.UI ? ctx.UI.itemRow(W) : null;
  if (!row) return;
  eq(row(ego).color, row(plain).color,
     '★未解析なのに改修品と素の装備で色が違う');
  ok(row(ego).text.indexOf('?') !== -1, '未解析の印が文字に出ていない');
});

console.log('\n' + pass + ' pass / ' + fail + ' fail');
process.exit(fail ? 1 : 0);
