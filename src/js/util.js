/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* util.js — 座標・方向・距離の純粋ヘルパ。DOM 非依存。 */
'use strict';

var U = (function () {

  /* 8方向。テンキー配置の順 (1..9 から 5 を除く) で並べる。
     この並びは input.js のキー対応と render の向き表示が共有する。 */
  var DIRS = [
    { dx: -1, dy:  1, key: 1 }, { dx: 0, dy:  1, key: 2 }, { dx: 1, dy:  1, key: 3 },
    { dx: -1, dy:  0, key: 4 },                            { dx: 1, dy:  0, key: 6 },
    { dx: -1, dy: -1, key: 7 }, { dx: 0, dy: -1, key: 8 }, { dx: 1, dy: -1, key: 9 }
  ];

  /* 直交4方向。通路掘りで使う。 */
  var ORTHO = [
    { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }
  ];

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** チェビシェフ距離。斜め移動が1歩なので、視界と射程はこれを使う (Angband 準拠)。 */
  function distCheb(x0, y0, x1, y1) {
    return Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  }

  /** 矩形が重なるか。room 配置の衝突判定用 (辺が接する場合も重なりとみなす)。 */
  function rectOverlap(a, b, pad) {
    pad = pad || 0;
    return !(a.x2 + pad < b.x1 || b.x2 + pad < a.x1 ||
             a.y2 + pad < b.y1 || b.y2 + pad < a.y1);
  }

  function rectCenter(r) {
    return { x: (r.x1 + r.x2) >> 1, y: (r.y1 + r.y2) >> 1 };
  }

  return {
    DIRS: DIRS, ORTHO: ORTHO,
    clamp: clamp, distCheb: distCheb,
    rectOverlap: rectOverlap, rectCenter: rectCenter
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = U;
