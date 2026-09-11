/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* rng.js — 乱数。
 *
 * 不変条件 (docs/01 §1.5-1): ゲーム内の乱数は必ずここを通す。
 * `Math.random()` の直接使用は禁止 (tools/check_code.js が検出して落とす)。
 * 同一シードで同一ダンジョンが再現できることが、テストとバグ再現の土台。
 *
 * アルゴリズムは xorshift128。周期 2^128-1、状態が 32bit×4 と小さく
 * セーブデータにそのまま入れられる (セーブスカム対策: docs/01 §1.4)。
 */
'use strict';

var RNG = (function () {

  /** 文字列 -> 32bit シード列 (xmur3)。同じ文字列は必ず同じ状態を生む。 */
  function seedFromString(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
  }

  /**
   * @param {string|number} [seed] 省略時は時刻から生成する。
   *        ※ 時刻由来なのはタイトル画面で「新しいランを始める」ときだけ。
   *          生成処理の内部では必ず明示シードを渡すこと。
   */
  function create(seed) {
    if (seed === undefined || seed === null) seed = 'strata-' + Date.now();
    var label = String(seed);
    var next32 = seedFromString(label);
    var s0 = next32(), s1 = next32(), s2 = next32(), s3 = next32();
    // 全ゼロ状態は縮退するので避ける
    if ((s0 | s1 | s2 | s3) === 0) s0 = 0x9e3779b9;

    var self = {
      /** このRNGを作った元のシード文字列 (画面表示・不具合報告用) */
      seed: label,

      /** 次の 32bit 符号なし整数 */
      u32: function () {
        var t = s3;
        var s = s0;
        s3 = s2; s2 = s1; s1 = s;
        t ^= t << 11;  t >>>= 0;
        t ^= t >>> 8;
        s0 = (t ^ s ^ (s >>> 19)) >>> 0;
        return s0;
      },

      /** [0,1) の浮動小数 */
      float: function () { return self.u32() / 4294967296; },

      /** [0,n) の整数。n<=0 なら 0。 */
      int: function (n) {
        if (n <= 0) return 0;
        return self.u32() % n;
      },

      /** [lo,hi] の整数 (両端を含む) */
      range: function (lo, hi) {
        if (hi < lo) { var t = lo; lo = hi; hi = t; }
        return lo + self.int(hi - lo + 1);
      },

      /** n個のsides面ダイス。Angband の damroll 相当。 */
      dice: function (n, sides) {
        var sum = 0;
        for (var i = 0; i < n; i++) sum += 1 + self.int(sides);
        return sum;
      },

      /** 確率 p (0..1) で true */
      chance: function (p) { return self.float() < p; },

      /** num/den の確率で true。整数比で書けるので浮動小数誤差が入らない。 */
      oneIn: function (den) { return self.int(den) === 0; },

      /** 配列から1つ選ぶ。空配列なら undefined。 */
      pick: function (arr) {
        if (!arr || arr.length === 0) return undefined;
        return arr[self.int(arr.length)];
      },

      /** 破壊的シャッフル (Fisher-Yates)。同じ配列・同じ状態なら同じ並び。 */
      shuffle: function (arr) {
        for (var i = arr.length - 1; i > 0; i--) {
          var j = self.int(i + 1);
          var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
      },

      /**
       * 派生RNG。用途ごとに独立した流れを作る。
       * 例: 階層生成用と戦闘用を分けると、生成コードを変えても戦闘の乱数がズレない。
       */
      derive: function (tag) { return create(label + '/' + tag + '/' + self.u32()); },

      /** セーブ用の状態。setState で完全に復元できる。 */
      state: function () { return { seed: label, s: [s0, s1, s2, s3] }; },

      setState: function (st) {
        label = st.seed;
        self.seed = label;
        s0 = st.s[0] >>> 0; s1 = st.s[1] >>> 0; s2 = st.s[2] >>> 0; s3 = st.s[3] >>> 0;
      }
    };
    return self;
  }

  return { create: create, seedFromString: seedFromString };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = RNG;
