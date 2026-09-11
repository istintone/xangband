/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* term.js — グリフバッファを Canvas に描く疑似ターミナル。shell 層 (DOM を触る)。
 *
 * ここは「バッファを絵にする」だけで、ゲームの判断は一切しない (docs/01 §1.6)。
 * タイル描画に差し替えるときは、このファイルの drawCell だけを置き換える。
 */
'use strict';

var Term = (function () {

  var canvas = null, ctx = null;
  /* ★寸法はすべて **device pixel** で持つ。
     CSS px で持って dpr を掛けると、セル境界が小数ピクセルに落ちて
     塗り直しの継ぎ目が滲み、差分描画で前の文字の縁が残る ([[D-59]])。 */
  var cellW = 0, cellH = 0, fontPx = 0, dpr = 1, glyphW = 0;
  var cssCellW = 0, cssCellH = 0;  // 当たり判定用 (画面座標 -> セル)
  var LINE_HEIGHT = 1.15;          // セル高 / フォントサイズ
  var prev = null;   // 前フレームのバッファ。差分だけ描き直す。

  /**
   * 端末が収まる最大の文字サイズを選ぶ。
   * 枠外UI(操作パネル・凡例HUD)があるので、**ウィンドウではなく #stage の実寸**を見る
   * ([[D-55]])。パネルを畳んだときも自動で追従する。
   */
  function fit() {
    var rows = Render.TERM.h;
    var stage = canvas.parentElement;
    var availW = (stage ? stage.clientWidth : window.innerWidth) - 8;
    var availH = (stage ? stage.clientHeight : window.innerHeight) - 8;

    dpr = window.devicePixelRatio || 1;

    // 文字幅とフォントサイズの比を実測する(フォントによって違う)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = '100px ' + FONT;
    var ratioW = ctx.measureText('W').width / 100 || 0.6;

    /* ★桁数を先に決める ([[D-84]])。
       行数は固定なのでセルの高さは availH で決まり、
       セルの縦横比を自然比に保つと1桁ぶんの幅も決まる。
       その幅で availW に何桁入るかが、この画面で出せる桁数。
       こうすると 16:9 の画面でも左右の黒帯が消え、マップが広く見える。 */
    var natural = ratioW / LINE_HEIGHT;
    var cellHFit = Math.max(6, Math.floor(availH * dpr / rows));
    var cellWFit = Math.max(4, Math.round(cellHFit * natural));
    var fitCols = Math.floor(availW * dpr / cellWFit);

    /* サイドバーを持つかは**画面幅だけ**で決める ([[D-87]])。
       CSS が縦積みにする幅(900px 以下)では必ず畳み、16桁をマップに回す。
       状態は枠外の HUD が要約札で出すので、情報は失われない。

       ★ここで端末側の都合(fitCols)だけを根拠にすると、
       CSS のレイアウトが変わって測定が変わり、測定がまた CSS を変える循環になる。
       判断は「画面幅 → 縦積みか → サイドバーを持つか」の一方向に保つ。 */
    var stacked = typeof window.matchMedia === 'function' &&
                  window.matchMedia('(max-width: 900px)').matches;
    Render.resize(fitCols, !stacked && fitCols >= Render.COLS_MIN);

    var cols = Render.TERM.w;

    /* ★セル寸法を先に決め、フォントをそこから逆算する。
       逆順(フォント→セル)にすると、cellH = fontPx * 行間 の分だけ
       端末が縦にはみ出して下端が切れる。
       ★寸法は device pixel の整数で決める。CSS px で決めて dpr を掛けると
       境界が小数になり、塗り直しの継ぎ目に前の文字の縁が残る ([[D-59]])。 */
    cellW = Math.max(4, Math.floor(availW * dpr / cols));
    cellH = Math.max(6, Math.floor(availH * dpr / rows));

    /* さらに、セルの縦横比を**フォントの自然な比**に揃える。
       揃えないと、制約の緩い方向にセルだけが広がって文字間が間延びする。
       桁数を先に決めてあるので、ここでの調整は丸め誤差ぶんに収まる。 */
    if (cellW / cellH > natural) cellW = Math.max(4, Math.round(cellH * natural));
    else cellH = Math.max(6, Math.round(cellW / natural));

    // セルに収まる最大のフォント(device pixel)
    fontPx = Math.max(7, Math.min(
      Math.floor(cellH / LINE_HEIGHT),
      Math.floor(cellW / ratioW)
    ));

    // バッキングストアは device pixel 単位。変換行列は等倍のまま使う。
    canvas.width = cols * cellW;
    canvas.height = rows * cellH;
    cssCellW = cellW / dpr;
    cssCellH = cellH / dpr;
    canvas.style.width = (cols * cssCellW) + 'px';
    canvas.style.height = (rows * cssCellH) + 'px';

    ctx.setTransform(1, 0, 0, 1, 0, 0);          // 等倍 = 境界が必ず整数
    ctx.font = fontPx + 'px ' + FONT;
    ctx.textBaseline = 'middle';                 // セルの縦中央に置く
    glyphW = ctx.measureText('W').width;
    prev = null;   // サイズが変わったら全描き直し
  }

  var FONT = '"Consolas", "DejaVu Sans Mono", "Courier New", monospace';

  function init(el) {
    canvas = el;
    ctx = canvas.getContext('2d', { alpha: false });
    canvas.tabIndex = 0;          // キー入力を受けるため
    fit();
    canvas.focus();
    window.addEventListener('resize', function () { fit(); if (last) draw(last); });
  }

  function drawCell(x, y, cell) {
    if (cell.w === 0) return;              // 全角の後続セルは先頭が描いている
    var span = cell.w || 1;
    var px = x * cellW, py = y * cellH;
    var boxW = cellW * span;

    ctx.fillStyle = Render.PALETTE[cell.bg] || Render.PALETTE.black;
    ctx.fillRect(px, py, boxW, cellH);

    if (cell.ch !== ' ' && cell.ch !== '') {
      ctx.fillStyle = Render.PALETTE[cell.fg] || Render.PALETTE.white;
      /* セル内で中央寄せする。セル幅はフォント幅より少し広いので、
         左寄せのままだと文字の右側だけ空いて画面が間延びして見える。 */
      var w = span === 1 ? glyphW : ctx.measureText(cell.ch).width;
      var ox = Math.max(0, (boxW - Math.min(w, boxW)) / 2);

      /* ★グリフを必ずセルの中に閉じ込める ([[D-60]])。
         フォントのインクは em box を上下に超えることがあり(特に和文の
         フォールバックや括弧・記号)、はみ出した分は隣のセルに残る。
         差分描画は変わったセルしか塗り直さないので、
         「上の行は変わらず下の行だけ変わる」と、上の行に前の文字の縁が残る。
         maxWidth だけでは横しか止まらないので、矩形でクリップする。 */
      ctx.save();
      ctx.beginPath();
      ctx.rect(px, py, boxW, cellH);
      ctx.clip();
      ctx.fillText(cell.ch, px + ox, py + cellH / 2, boxW);
      ctx.restore();
    }
  }

  var last = null;

  /** バッファを描く。前フレームと同じセルは飛ばす。 */
  function draw(buf) {
    last = buf;
    if (!prev || prev.w !== buf.w || prev.h !== buf.h) {
      ctx.fillStyle = Render.PALETTE.black;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      prev = null;
    }
    for (var y = 0; y < buf.h; y++) {
      for (var x = 0; x < buf.w; x++) {
        var i = y * buf.w + x;
        var c = buf.cells[i];
        if (prev) {
          var p = prev.cells[i];
          if (p.ch === c.ch && p.fg === c.fg && p.bg === c.bg && p.w === c.w) continue;
        }
        drawCell(x, y, c);
      }
    }
    // 次フレームとの比較用にコピーを取る (buf は使い回されないが念のため)
    prev = { w: buf.w, h: buf.h, cells: buf.cells.map(function (c) {
      return { ch: c.ch, fg: c.fg, bg: c.bg, w: c.w };
    }) };
  }

  /**
   * 画面座標を端末のセル座標に変換する。マウス操作の土台 ([[D-57]])。
   * @returns {object|null} { x, y } 端末セル。範囲外なら null
   */
  function cellAt(clientX, clientY) {
    if (!canvas || !cssCellW || !cssCellH) return null;
    // 当たり判定は CSS px。描画は device px なので単位が違う点に注意。
    var r = canvas.getBoundingClientRect();
    var x = Math.floor((clientX - r.left) / cssCellW);
    var y = Math.floor((clientY - r.top) / cssCellH);
    if (x < 0 || y < 0 || x >= Render.TERM.w || y >= Render.TERM.h) return null;
    return { x: x, y: y };
  }

  /** クリックハンドラを繋ぐ。handler({x,y}) は端末セル座標を受け取る。 */
  function onClick(handler) {
    if (!canvas) return;
    canvas.addEventListener('click', function (ev) {
      canvas.focus();
      var cell = cellAt(ev.clientX, ev.clientY);
      if (cell) handler(cell, ev);
    });
  }

  /** 再測定して描き直す。パネルの開閉から呼ぶ。 */
  function relayout() {
    fit();
    if (last) draw(last);
  }

  return {
    init: init, draw: draw, cellAt: cellAt, onClick: onClick, relayout: relayout,
    focus: function () { if (canvas) canvas.focus(); }
  };
})();
