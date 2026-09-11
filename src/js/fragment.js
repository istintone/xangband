/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* fragment.js — ログ断片。docs/07 §7.3, §7.8。DOM 非依存。
 *
 * 物語を**説明せずに**置くための唯一の手段 ([[D-45]])。
 * 強制イベントもカットシーンも作らない。落ちているものを拾って読むだけ。
 *
 * 拾った時点で全文が読め、**所持品には入らない**。
 * 読み物で所持枠を圧迫させないため。収集済みの id は W.loreFound に溜まり、
 * 勝利画面での結末の解像度を決める (§7.8)。
 *
 * データは src/data/lore.json。敵の知識 (lore.js) とは別物。
 */
'use strict';

var Fragment = (function () {

  function all() { return Data.get().fragments; }

  function byId(id) { return Data.get().fragmentsById[id]; }

  /** 床に置ける断片(stage 5 は勝利画面専用なので除く)。 */
  function placeable() {
    return all().filter(function (f) { return f.stage < 5; });
  }

  /** 収集済みか。 */
  function found(W, id) { return !!(W.loreFound && W.loreFound[id]); }

  function foundCount(W) {
    return W.loreFound ? Object.keys(W.loreFound).length : 0;
  }

  /** 収集率 0..1。分母は**床に置ける断片だけ**(集められないものを分母に入れない)。 */
  function ratio(W) {
    var total = placeable().length;
    if (!total) return 0;
    var got = 0;
    var list = placeable();
    for (var i = 0; i < list.length; i++) if (found(W, list[i].id)) got++;
    return got / total;
  }

  /**
   * この深度・このサイトで出うる、まだ拾っていない断片。
   * 深度帯を守るのは、開示の順序そのものが設計だから (§7.3)。
   */
  function candidates(W, depth, siteId) {
    return placeable().filter(function (f) {
      if (found(W, f.id)) return false;
      if (depth < f.depthMin || depth > f.depthMax) return false;
      if (f.sites && f.sites.indexOf(siteId) === -1) return false;
      return true;
    });
  }

  /**
   * 床に断片を1つ置く。候補が無ければ何も置かない。
   * @returns {object|null} 置いたアイテム
   */
  function place(rng, W, x, y, depth) {
    var siteId = W.site ? W.site.id : null;
    var pool = candidates(W, depth, siteId);
    if (!pool.length) return null;
    return dropAt(W, rng.pick(pool), x, y);
  }

  /** 指定の断片を床に置く。 */
  function dropAt(W, frag, x, y) {
    var it = {
      uid: Item.nextUid(),
      kindId: null,
      fragmentId: frag.id,
      base: 'fragment',
      name: frag.title,
      glyph: '?',
      color: 'yellow',
      slot: null,
      stackable: false,
      count: 1,
      weight: 0,
      known: true,
      sigils: [],
      x: x, y: y
    };
    W.items.push(it);
    return it;
  }

  /**
   * 断片を拾った。**所持品には入れず**、読んで記録する。
   * @returns {boolean} 新しく記録したら true
   */
  function collect(W, it) {
    var frag = byId(it.fragmentId);
    if (!frag) return false;
    if (!W.loreFound) W.loreFound = {};

    var isNew = !W.loreFound[frag.id];
    W.loreFound[frag.id] = true;

    World.msg(W, '―― ' + frag.title + ' ――');
    World.msg(W, frag.text);
    if (isNew) {
      World.msg(W, '記録した。(' + foundCount(W) + '/' + placeable().length + ')');
    }
    return isNew;
  }

  function isFragment(it) { return !!(it && it.fragmentId); }

  /**
   * 勝利画面で開示する結末 (§7.8)。収集率で解像度が変わる。
   * **全部集めなくても勝てる。集めた者だけが意味を知る。**
   */
  var TIERS = [
    { min: 0.85, take: 4 },
    { min: 0.60, take: 3 },
    { min: 0.30, take: 2 },
    { min: 0.00, take: 0 }
  ];

  function ending(W) {
    var r = ratio(W);
    var take = 0;
    for (var i = 0; i < TIERS.length; i++) {
      if (r >= TIERS[i].min) { take = TIERS[i].take; break; }
    }
    var finale = all().filter(function (f) { return f.stage === 5; });
    finale.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    return { ratio: r, revealed: finale.slice(0, take), total: finale.length };
  }

  return {
    all: all, byId: byId, placeable: placeable,
    found: found, foundCount: foundCount, ratio: ratio,
    candidates: candidates, place: place, dropAt: dropAt,
    collect: collect, isFragment: isFragment, ending: ending
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Fragment;
