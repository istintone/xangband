/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* item.js — アイテムの生成・効果・床への配置。DOM 非依存。
 *
 * M1 は「基本形のみ」。改修品(エゴ)・固有機材・ルーン式鑑定は M2 (docs/04)。
 */
'use strict';

var Item = (function () {

  var nextId = 1;

  /** 定義から実体を作る。定義(kind)は共有し、個体の状態だけを持つ。 */
  function create(rng, kind, count) {
    var base = Data.get().itemBase[kind.base];
    var it = {
      uid: nextId++,
      kindId: kind.id,
      base: kind.base,
      name: kind.name,
      glyph: base.glyph,
      color: base.color,
      slot: base.slot,
      stackable: !!base.stack,
      count: count || 1,
      weight: kind.weight || 0,
      x: 0, y: 0
    };
    // 種別ごとの値をコピー (存在するものだけ)
    ['dice', 'toHit', 'toDam', 'ac', 'seal', 'radius', 'cellUse', 'effect', 'cost',
     'mult', 'ammo', 'ammoType'].forEach(function (k) {
      if (kind[k] !== undefined) it[k] = kind[k];
    });
    it.sigils = [];
    it.pval = 0;
    if (kind.charges) it.charges = Data.rollDice(rng, kind.charges);
    if (kind.base === 'credit') it.count = 1;
    return it;
  }

  /* ---------- 改修品(エゴ)・固有機材 (docs/02 §2.8) ---------- */

  /**
   * 「良い品」の判定。深度が深いほど通りやすい (本家の構造)。
   * @returns {'normal'|'ego'|'unique'}
   */
  function qualityRoll(rng, depth) {
    // 本家 GREAT_OBJ / GOOD_OBJ 相当。深度で線形に上がり、上限で頭打ち。
    var goodChance = Math.min(45, 8 + depth);          // %
    if (rng.int(100) >= goodChance) return 'normal';
    var greatChance = Math.min(35, 4 + Math.floor(depth / 2));
    if (rng.int(100) < greatChance) return 'unique';
    return 'ego';
  }

  /** その深度・そのベースに付けられる改修品を1つ選ぶ。 */
  function pickEgo(rng, base, depth) {
    var list = Data.get().egos.filter(function (e) {
      return e.bases.indexOf(base) !== -1;
    });
    /* 改修品も装備と同じように歳を取る ([[D-77]])。
       既定の猶予のままだと、深度80 の装備に「補強(+2)」が付いてしまう。 */
    return Data.allocate(rng, list, depth, Data.ITEM_WINDOW);
  }

  function applyEgo(it, ego) {
    it.egoId = ego.id;
    it.egoName = ego.name;
    it.toHit = (it.toHit || 0) + (ego.toHit || 0);
    it.toDam = (it.toDam || 0) + (ego.toDam || 0);
    it.ac = (it.ac || 0) + (ego.ac || 0);
    it.pval = ego.pval || 0;
    it.sigils = (ego.sigils || []).slice();
    if (ego.taint) {
      // 汚染ファームは強力な利点と同居する形でのみ生成する ([[D-07]])
      it.sigils = it.sigils.concat(ego.taint);
      it.tainted = true;
    }
    it.cost = (it.cost || 0) + (ego.cost || 0);
    return it;
  }

  /**
   * 固有機材を試みる。**1ランに1個**しか存在しない ([[D-38]])。
   * @param W 生成済みフラグを持つ世界状態。null なら固有機材を作らない。
   */
  function tryUnique(rng, W, base, depth) {
    if (!W) return null;
    var list = Data.get().uniques.filter(function (u) {
      return u.base === base && !W.uniquesMade[u.id];
    });
    if (list.length === 0) return null;
    var u = Data.allocate(rng, list, depth);
    if (!u) return null;
    W.uniquesMade[u.id] = true;
    return u;
  }

  function applyUnique(it, u) {
    it.uniqueId = u.id;
    it.name = u.name;
    it.egoName = null;
    it.toHit = u.toHit || 0;
    it.toDam = u.toDam || 0;
    if (u.ac !== undefined) it.ac = u.ac;
    it.pval = u.pval || 0;
    it.sigils = (u.sigils || []).slice();
    if (u.taint) { it.sigils = it.sigils.concat(u.taint); it.tainted = true; }
    it.cost = u.cost || it.cost;
    it.desc = u.desc;
    return it;
  }

  /**
   * 深度に応じたアイテムを1つ作る。
   * @param W 固有機材の生成済み管理に使う。省略すると固有機材は出ない。
   */
  function makeForDepth(rng, depth, W) {
    var kind = Data.pickItem(rng, depth);
    if (!kind) return null;

    if (kind.base === 'credit') {
      var money = create(rng, kind, 1);
      money.amount = rng.range(5, 20) + depth * rng.range(2, 8);
      return money;
    }

    var count = 1;
    if (kind.base === 'ampule' || kind.base === 'protocol') count = rng.oneIn(4) ? 2 : 1;
    if (kind.base === 'ration' || kind.base === 'cell') count = rng.range(1, 3);
    if (kind.base === 'ammo') count = rng.range(8, 24);
    var it = create(rng, kind, count);

    // 装備できるものだけが改修品・固有機材になりうる
    if (it.slot) {
      var q = qualityRoll(rng, depth);
      if (q === 'unique') {
        var u = tryUnique(rng, W, kind.id, depth);
        if (u) return applyUnique(it, u);
        q = 'ego';                                  // 固有機材が尽きたら改修品に落とす
      }
      if (q === 'ego') {
        var ego = pickEgo(rng, kind.base, depth);
        if (ego) applyEgo(it, ego);
      }
    }
    return it;
  }

  /** 同じものとして重ねられるか。 */
  function canStack(a, b) {
    return a.stackable && b.stackable && a.kindId === b.kindId && !a.amount && !b.amount;
  }

  /** 階層に床アイテムを撒く。 */
  function populate(rng, W, depth) {
    var count = 3 + rng.range(0, 3) + Math.floor(depth / 4);
    for (var i = 0; i < count; i++) {
      var it = makeForDepth(rng, depth, W);
      if (!it) continue;
      var spot = Monster.findSpawnSpot(rng, W, 0);
      if (!spot) continue;
      it.x = spot.x; it.y = spot.y;
      W.items.push(it);
    }
  }

  /** 指定座標にアイテムを1つ置く (区画テンプレート/Vault の * と & 用)。 */
  function placeAt(rng, W, x, y, depth) {
    var it = makeForDepth(rng, depth, W);
    if (!it) return null;
    it.x = x; it.y = y;
    W.items.push(it);
    return it;
  }

  function itemsAt(W, x, y) {
    var out = [];
    for (var i = 0; i < W.items.length; i++) {
      if (W.items[i].x === x && W.items[i].y === y) out.push(W.items[i]);
    }
    return out;
  }

  function removeFromFloor(W, it) {
    var i = W.items.indexOf(it);
    if (i !== -1) W.items.splice(i, 1);
  }

  /* ---------- 消費アイテムの効果 ---------- */

  /**
   * 効果の解決は effect.js に委譲する。
   * 「アンプルで回復」と「能力で回復」を二重実装しない。
   * @returns {boolean} 消費したら true
   */
  function applyEffect(W, p, it) {
    var consumed = Effect.apply(W, p, it.effect, null);
    if (consumed) Sigil.learnKind(W, it.kindId);   // 使えば種別が分かる (フレーバー式)
    return consumed;
  }

  function revealAround(W, cx, cy, r) { return Effect.revealAround(W, cx, cy, r); }
  function teleport(W, a, dist) { return Effect.teleport(W, a, dist); }

  function nextUid() { return nextId++; }

  /** セーブからの復元後に uid の採番を進める (衝突防止)。 */
  function syncNextId(items) {
    for (var i = 0; i < items.length; i++) {
      if (items[i].uid >= nextId) nextId = items[i].uid + 1;
    }
  }

  return {
    create: create, makeForDepth: makeForDepth, canStack: canStack,
    qualityRoll: qualityRoll, pickEgo: pickEgo, applyEgo: applyEgo,
    tryUnique: tryUnique, applyUnique: applyUnique, placeAt: placeAt,
    populate: populate, itemsAt: itemsAt, removeFromFloor: removeFromFloor,
    applyEffect: applyEffect, teleport: teleport, revealAround: revealAround,
    nextUid: nextUid, syncNextId: syncNextId
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Item;
