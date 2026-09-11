/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* origin.js — 《起源》深度80〜100 の構造。docs/07 §7.4。DOM 非依存。
 *
 * 他のサイトと違い、**部分的に固定**する (docs/02 §2.3 の例外)。
 *
 *   80–89 接続層  … 4サイトの生成器を階ごとに切り替える。「どれにも似ている」
 *   90–97 中枢層  … 同じ生成器を歪ませる。地形が破綻していく
 *   98    静止層  … 固定。敵もアイテムも無い。ログ断片だけ
 *   99    《門番》 … 固定。倒すまで降下シャフトが開かない
 *   100   《起源》 … 固定。ここで終わる
 *
 * 98 で静かにさせることが 99・100 の重さを作る。
 * 本家の深度100 が唐突に始まるのに対し、ここは意図的に間を置く。
 */
'use strict';

var Origin = (function () {

  var T = World.TILE;

  function data() { return Data.get().origin; }

  /** その深度の層。《起源》以外のサイトなら null。 */
  function layerOf(depth) {
    var d = data();
    if (!d) return null;
    for (var i = 0; i < d.layers.length; i++) {
      var L = d.layers[i];
      if (depth >= L.depthMin && depth <= L.depthMax) return L;
    }
    return null;
  }

  /** その深度に固定マップがあるか。 */
  function fixedFor(depth) {
    var d = data();
    if (!d) return null;
    for (var i = 0; i < d.maps.length; i++) {
      if (d.maps[i].depth === depth) return d.maps[i];
    }
    return null;
  }

  /** 入階時に一言告げる文。層ごとに変わる。 */
  function enterText(depth) {
    var fx = fixedFor(depth);
    if (fx) return fx.enterText;
    var L = layerOf(depth);
    return L ? L.enterText : null;
  }

  /* ---------- 80〜97: 生成パラメータ ---------- */

  /**
   * 接続層は**階ごとに別のサイトの生成器**を使う。
   * 「4サイトが同じものだった」ことを、説明ではなく地形で示す (docs/07 §7.3)。
   * @returns {object} { opts, lookSite } lookSite は見た目を借りるサイト
   */
  function genFor(rng, depth) {
    var L = layerOf(depth);
    if (!L) return null;

    if (L.mixSites) {
      // 深度で決める。同じ深度なら同じサイトの顔をしている(再訪で像がブレない)
      var id = L.mixSites[depth % L.mixSites.length];
      var borrowed = Site.byId(id);
      if (borrowed) return { opts: Site.genOpts(borrowed), lookSite: borrowed };
    }
    return { opts: L.gen ? shallow(L.gen) : {}, lookSite: null };
  }

  function shallow(o) {
    var c = {};
    for (var k in o) c[k] = o[k];
    return c;
  }

  /* ---------- 98〜100: 固定マップ ---------- */

  /**
   * 固定マップから階層を作る。
   * @returns {object} { level, marks } marks は cmd.js が中身を置くのに使う
   */
  function buildFixed(rng, spec, env, W) {
    var h = spec.map.length;
    var w = 0;
    for (var i = 0; i < h; i++) w = Math.max(w, spec.map[i].length);

    // 周囲に1マス余白を付ける。端に階段が来ると視界計算が窮屈になる。
    var lv = World.createLevel(w + 2, h + 2);
    lv.depth = spec.depth;
    lv.env = env;
    lv.fixedId = spec.id;

    var marks = [];
    for (var y = 0; y < h; y++) {
      var row = spec.map[y];
      for (var x = 0; x < row.length; x++) {
        var mx = x + 1, my = y + 1;
        var ch = row[x];
        if (ch === '#') { World.setTile(lv, mx, my, T.WALL); continue; }

        World.setTile(lv, mx, my, T.FLOOR);
        World.addFlag(lv, mx, my, World.F.GLOW);

        if (ch === '<') { World.setTile(lv, mx, my, T.UP); lv.up = { x: mx, y: my }; }
        else if (ch === '>') { World.setTile(lv, mx, my, T.DOWN); lv.down = { x: mx, y: my }; }
        else if (ch === 'L') marks.push({ kind: 'lore', x: mx, y: my });
        else if (ch === 'W') marks.push({ kind: 'warden', x: mx, y: my });
        else if (ch === 'O') marks.push({ kind: 'origin', x: mx, y: my });
      }
    }

    // 部屋は1つ扱い。FOV の「明るい部屋」判定が全体に効くようにする。
    lv.rooms = [{ x1: 1, y1: 1, x2: w, y2: h, lit: true }];
    lv.marks = [];
    lv.special = [];
    lv.attempts = 1;

    /* 既に《門番》を倒しているなら、シャフトは開いたまま再生成する。
       階層は非永続なので再訪のたびに作り直されるが、
       **一度開いた道が閉じてはいけない**。 */
    if (spec.id === 'warden' && W && W.uniquesKilled && W.uniquesKilled['u-warden']) {
      marks = marks.filter(function (m) { return m.kind !== 'warden'; });
      var w0 = wardenSpot(spec);
      if (w0) {
        World.setTile(lv, w0.x, w0.y, T.DOWN);
        lv.down = { x: w0.x, y: w0.y };
      }
    }

    // 上りが無い階は作らない(入った瞬間に戻れなくなる)
    if (!lv.up) throw new Error('origin: 固定マップに昇降機が無い: ' + spec.id);
    return { level: lv, marks: marks };
  }

  /** 固定マップ上の 'W' の位置(余白1マスぶんずらした座標)。 */
  function wardenSpot(spec) {
    for (var y = 0; y < spec.map.length; y++) {
      var x = spec.map[y].indexOf('W');
      if (x !== -1) return { x: x + 1, y: y + 1 };
    }
    return null;
  }

  /**
   * 《門番》を倒した。深度100 への降下シャフトを開く。
   * 最初から開けておくと、戦わずに素通りできてしまう。
   */
  function openWardenShaft(W) {
    var lv = W.level;
    if (lv.fixedId !== 'warden' || lv.down) return false;
    // 《門番》が立っていた場所がそのまま道になる
    var x = W.wardenAt ? W.wardenAt.x : lv.up.x;
    var y = W.wardenAt ? W.wardenAt.y : lv.up.y - 1;
    if (!World.inBounds(lv, x, y)) { x = lv.up.x; y = lv.up.y; }
    World.setTile(lv, x, y, T.DOWN);
    lv.down = { x: x, y: y };
    World.msg(W, '床が落ち込み、さらに下へ続く道が開いた。');
    return true;
  }

  return {
    layerOf: layerOf, fixedFor: fixedFor, enterText: enterText,
    genFor: genFor, buildFixed: buildFixed, openWardenShaft: openWardenShaft
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Origin;
