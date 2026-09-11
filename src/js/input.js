/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* input.js — キー入力の解釈。shell 層。
 *
 * 3流儀 (vi風 / テンキー / 矢印) を同時受付する ([[D-26]])。
 * ここは「キー -> コマンド名」の変換だけ。実行は cmd.js が持つ。
 */
'use strict';

var Input = (function () {

  /* vi風。yubn が斜め (Angband 標準)。 */
  var VI = {
    h: [-1, 0], j: [0, 1], k: [0, -1], l: [1, 0],
    y: [-1, -1], u: [1, -1], b: [-1, 1], n: [1, 1]
  };

  /* テンキー。5 は「その場で待つ」。 */
  var NUM = {
    '1': [-1, 1], '2': [0, 1], '3': [1, 1],
    '4': [-1, 0], '5': [0, 0], '6': [1, 0],
    '7': [-1, -1], '8': [0, -1], '9': [1, -1]
  };

  var ARROW = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]
  };

  /* 'u' は vi風では斜め移動、UI が開いているときは項目選択。
     移動として解釈されるのはマップ画面のときだけ。 */
  var MENU_KEY = {
    i: 'inventory', e: 'equip', u: 'use', w: 'wear', d: 'drop',
    m: 'ability', C: 'char', M: 'lore', '?': 'help'
  };

  /**
   * マップ画面でのキー解釈。
   * @returns {object|null}
   */
  function mapCommand(ev) {
    var k = ev.key;

    // 連続移動: Shift + 方向 ([[D-50]])
    if (ev.shiftKey && ARROW[k]) return { type: 'run', dx: ARROW[k][0], dy: ARROW[k][1] };
    if (ev.shiftKey && VI[k.toLowerCase()] && k !== 'L' && k !== 'N' && k !== 'S' && k !== 'R') {
      var v = VI[k.toLowerCase()];
      return { type: 'run', dx: v[0], dy: v[1] };
    }

    if (ARROW[k]) return { type: 'move', dx: ARROW[k][0], dy: ARROW[k][1] };
    if (NUM[k]) return { type: 'move', dx: NUM[k][0], dy: NUM[k][1] };

    // メニューを開くキーは移動より先に見る ('u' の衝突を解消する)
    if (MENU_KEY[k]) return { type: 'menu', mode: MENU_KEY[k] };

    if (!ev.shiftKey && VI[k]) return { type: 'move', dx: VI[k][0], dy: VI[k][1] };

    if (k === '>') return { type: 'descend' };
    if (k === '<') return { type: 'ascend' };
    if (k === '.' || k === 's') return { type: 'move', dx: 0, dy: 0 };
    if (k === 'g' || k === ',') return { type: 'pickup' };
    if (k === 'L') return { type: 'light' };
    if (k === 'f') return { type: 'shoot' };
    if (k === 'x') return { type: 'look' };
    if (k === 'R') return { type: 'rest' };
    if (k === 'Enter') return { type: 'enter' };
    if (k === 'V') return { type: 'menu', mode: 'site' };
    if (k === 'J') return { type: 'menu', mode: 'net' };
    if (k === '=') return { type: 'menu', mode: 'display' };
    if (k === '\\') return { type: 'panels' };   // 枠外UI の表示量 ([[D-83]])
    /* Space は最も押しやすいキーなので、最も使う機能に割り当てる ([[D-85]])。
       注視の対象送りは Tab に一本化した。 */
    if (k === ' ') return { type: 'menu', mode: 'act' };

    if (k === 'S') return { type: 'save' };
    if (ev.ctrlKey && (k === 'l' || k === 'L')) return { type: 'load' };
    if (ev.ctrlKey && (k === 'p' || k === 'P')) return { type: 'menu', mode: 'log' };
    // デバッグ用。決定論を目で確かめるために残す (R は休息に譲った)。
    if (ev.ctrlKey && (k === 'r' || k === 'R')) return { type: 'regen' };
    if (k === 'N') return { type: 'newseed' };

    return null;
  }

  /** UI が開いているときのキー解釈。 */
  function menuCommand(ev) {
    var k = ev.key;
    var mode = UI.current();

    // --- 注視モード (docs/09 §9.4) ---
    if (mode === 'look') {
      if (k === 'Escape' || k === 'q' || k === 'x') return { type: 'close' };
      if (k === 'Tab') return { type: 'lookCycle', dir: ev.shiftKey ? -1 : 1 };
      if (k === 't' || k === 'Enter') return { type: 'lookTarget' };
      // カーソルの位置まで歩く ([[D-86]])。タップ移動のキーボード版
      if (k === '.' || k === 'g') return { type: 'lookTravel' };
      if (ARROW[k]) return { type: 'lookMove', dx: ARROW[k][0], dy: ARROW[k][1] };
      if (NUM[k] && k !== '5') return { type: 'lookMove', dx: NUM[k][0], dy: NUM[k][1] };
      if (VI[k]) return { type: 'lookMove', dx: VI[k][0], dy: VI[k][1] };
      return null;
    }

    // --- キャラクター作成 (docs/09 §9.7) ---
    if (mode === 'lineage' || mode === 'role') {
      if (k === '*') return { type: 'createRandom' };
      if (k === 'Escape') return { type: 'createBack' };
      if (ARROW[k] || NUM[k]) {
        var d = ARROW[k] || NUM[k];
        if (d[1]) return { type: 'createHover', delta: d[1] };
        return null;
      }
      if (k.length === 1) {
        var ci = UI.indexOfLetter(k);
        if (ci >= 0) return { type: 'select', index: ci };
      }
      return null;
    }

    if (k === 'Escape' || k === 'q') return { type: 'close' };
    if (k === 'N') return { type: 'newseed' };

    /* カーソルで選ぶ ([[D-88]])。文字キーと併存させる ――
       速さが要るときは文字、確かめたいときはカーソル。
       左右も上下と同じ扱いにする(一覧は縦一列なので迷わせない)。 */
    if (k === 'ArrowUp' || k === 'ArrowLeft') return { type: 'menuMove', delta: -1 };
    if (k === 'ArrowDown' || k === 'ArrowRight') return { type: 'menuMove', delta: 1 };
    if (k === 'PageUp') return { type: 'menuMove', delta: -5 };
    if (k === 'PageDown') return { type: 'menuMove', delta: 5 };
    if (k === 'Home') return { type: 'menuMove', delta: -999 };
    if (k === 'End') return { type: 'menuMove', delta: 999 };
    if (k === 'Enter' || k === ' ') return { type: 'menuPick' };

    // モード固有の追加キー。小文字の項目選択と衝突しないよう大文字を使う。
    if (mode === 'ability' && k === 'G') return { type: 'learnMenu' };
    if (mode === 'shop') {
      if (k === 's') return { type: 'sellMenu' };
      if (k === 'A') return { type: 'service', name: 'analyze' };
      if (k === 'C') return { type: 'service', name: 'cure' };
      if (k === 'R') return { type: 'service', name: 'repair' };
      if (k === 'B') return { type: 'service', name: 'salvage' };
      if (k === 'G') return { type: 'service', name: 'graft' };
    }
    if (mode === 'home' && k === 's') return { type: 'storeMenu' };

    if (k.length === 1) {
      var i = UI.indexOfLetter(k);
      if (i >= 0) return { type: 'select', index: i };
    }
    return null;
  }

  function toCommand(ev) {
    return UI.isOpen() ? menuCommand(ev) : mapCommand(ev);
  }

  /** canvas にキーハンドラを繋ぐ。handler(cmd) が呼ばれる。 */
  function attach(el, handler) {
    el.addEventListener('keydown', function (ev) {
      var cmd = toCommand(ev);
      if (!cmd) return;
      ev.preventDefault();
      handler(cmd);
    });
    el.addEventListener('mousedown', function () { el.focus(); });
  }

  return { toCommand: toCommand, mapCommand: mapCommand, menuCommand: menuCommand, attach: attach };
})();
