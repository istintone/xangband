/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* inventory.js — 所持品・装備スロット・重量。DOM 非依存。
 *
 * docs/02 §2.8: 重量超過で速度が落ちる。取捨選択を強いる本家の仕組みは必ず入れる。
 */
'use strict';

var Inventory = (function () {

  var MAX_ITEMS = 23;   // a〜w。本家と同じく1画面に収まる数に抑える

  /* 装備スロット。M1 で使うぶんだけ。implant は M2 で2枠に増やす。 */
  var SLOTS = ['weapon', 'launcher', 'body', 'plate', 'light', 'neck', 'implant', 'implant2'];
  var SLOT_NAME = {
    weapon: '兵装', launcher: '射出器', body: 'スーツ', plate: '装甲板',
    light: 'ライト', neck: 'ニューラルリンク', implant: 'インプラント', implant2: 'インプラント2'
  };
  /* implant2 は系統 EXTRA_IMPLANT(義体化人類) のみ使える。 */
  function slotEnabled(p, slot) {
    if (slot === 'implant2') return Player.hasFlag(p, 'EXTRA_IMPLANT');
    return true;
  }

  function create() {
    var eq = {};
    for (var i = 0; i < SLOTS.length; i++) eq[SLOTS[i]] = null;
    return { items: [], equip: eq, credits: 0 };
  }

  /**
   * 積載上限。体力から決まる (docs/02 §2.8)。18/xx 対応。
   * @param env 現在階の環境。渡すと重力が効く (docs/08 §8.3)。
   */
  function capacity(p, env) {
    var base = 200 + Stat.carryMult(Stat.effective(p, 'str')) * 60;
    return env ? Math.round(base * Env.carryMod(env)) : base;
  }

  function totalWeight(inv) {
    var w = 0, i;
    for (i = 0; i < inv.items.length; i++) w += inv.items[i].weight * inv.items[i].count;
    for (i = 0; i < SLOTS.length; i++) {
      var e = inv.equip[SLOTS[i]];
      if (e) w += e.weight;
    }
    return w;
  }

  /**
   * 重量超過による速度低下。
   * 上限の 100% を超えるごとに -1 ずつ、最大 -10。
   */
  function speedPenalty(p, inv, env) {
    var cap = capacity(p, env);
    var over = totalWeight(inv) - cap;
    if (over <= 0) return 0;
    return -Math.min(10, 1 + Math.floor(over / Math.max(1, cap / 10)));
  }

  /**
   * 所持品に加える。スタックできればまとめる。
   * @returns {object|null} 入った項目。満杯なら null
   */
  function add(inv, it) {
    if (it.amount) {                      // クレジット
      inv.credits += it.amount;
      return it;
    }
    if (it.stackable) {
      for (var i = 0; i < inv.items.length; i++) {
        if (Item.canStack(inv.items[i], it)) {
          inv.items[i].count += it.count;
          return inv.items[i];
        }
      }
    }
    if (inv.items.length >= MAX_ITEMS) return null;
    inv.items.push(it);
    sort(inv);
    return it;
  }

  /** 1個(または n 個)減らす。0 になったら取り除く。 */
  function consume(inv, it, n) {
    n = n || 1;
    it.count -= n;
    if (it.count <= 0) {
      var i = inv.items.indexOf(it);
      if (i !== -1) inv.items.splice(i, 1);
    }
  }

  function remove(inv, it) {
    var i = inv.items.indexOf(it);
    if (i !== -1) inv.items.splice(i, 1);
  }

  /** 種別順→名前順。表示の並びが安定するようにする。 */
  function sort(inv) {
    var order = {};
    var bases = Data.get().itemBase;
    var n = 0;
    for (var k in bases) order[k] = n++;
    inv.items.sort(function (a, b) {
      var d = (order[a.base] || 0) - (order[b.base] || 0);
      if (d !== 0) return d;
      return a.kindId < b.kindId ? -1 : (a.kindId > b.kindId ? 1 : 0);
    });
  }

  /**
   * 装備する。同じスロットに既に何かあれば所持品へ戻す。
   * @returns {object} { ok, replaced, reason }
   */
  function equip(inv, it, p) {
    if (!it.slot) return { ok: false, reason: 'これは装備できない。' };

    var slot = it.slot;
    // インプラントは空いている枠を探す (義体化人類は2枠)
    if (slot === 'implant' && inv.equip.implant && p && slotEnabled(p, 'implant2') && !inv.equip.implant2) {
      slot = 'implant2';
    }
    var prev = inv.equip[slot] || null;
    remove(inv, it);
    inv.equip[slot] = it;
    if (prev) {
      if (!add(inv, prev)) {
        // 戻せないなら装備を元に戻す(アイテムを消さない)
        inv.equip[slot] = prev;
        add(inv, it);
        return { ok: false, reason: '所持品がいっぱいで持ち替えられない。' };
      }
    }
    return { ok: true, replaced: prev, slot: slot };
  }

  function unequip(inv, slot) {
    var it = inv.equip[slot];
    if (!it) return { ok: false, reason: '何も装備していない。' };
    if (!add(inv, it)) return { ok: false, reason: '所持品がいっぱいだ。' };
    inv.equip[slot] = null;
    return { ok: true, item: it };
  }

  /* ---------- 装備から導かれる値 ---------- */

  function weapon(inv) { return inv.equip.weapon; }

  /**
   * 装備の刻印をすべて集計する。
   * 未知の刻印も**効果は発揮する**(知らないだけで効いている — 本家準拠)。
   */
  function equipBonus(inv) {
    var all = [];
    var pvalMax = 0;
    for (var i = 0; i < SLOTS.length; i++) {
      var e = inv.equip[SLOTS[i]];
      if (!e || !e.sigils) continue;
      all = all.concat(e.sigils);
      pvalMax = Math.max(pvalMax, e.pval || 0);
    }
    // pval は装備ごとに違うが、M2 では最大値でまとめる。
    // 【暫定】装備ごとに個別集計するのは M3 で検討する。
    return Sigil.collect(all, pvalMax || 1);
  }

  function totalAC(inv) {
    var ac = 0;
    for (var i = 0; i < SLOTS.length; i++) {
      var e = inv.equip[SLOTS[i]];
      if (e && e.ac) ac += e.ac;
    }
    return ac;
  }

  function totalSeal(inv) {
    var s = 0;
    for (var i = 0; i < SLOTS.length; i++) {
      var e = inv.equip[SLOTS[i]];
      if (e && e.seal) s += e.seal;
    }
    return s;
  }

  /** 光源半径。ライトを装備していて電力があれば伸びる。刻印「照射」で加算。 */
  function lightRadius(p, inv) {
    if (p.timers.blind > 0) return 0;
    var base = Math.max(1, p.infra || 0);              // 系統の暗視
    var l = inv.equip.light;
    if (l && l.radius && p.cells > 0 && !p.lightOff) base = Math.max(base, l.radius);
    if (p.equipBonus && p.equipBonus.light) base += p.equipBonus.light;
    return U.clamp(base, 0, 6);
  }

  /**
   * 表示ラベル。鑑定状態を反映する (sigil.js が名前を組み立てる)。
   * @param K 知識。省略すると素の名前になる(テスト用)。
   */
  function label(it, K) {
    var s = K ? Sigil.name(K, it) : it.name;
    if (it.count > 1) s = it.count + '個の' + s;
    if (it.charges !== undefined) s += ' (' + it.charges + ')';
    if (it.tainted) s += ' {汚染}';
    if (it.damaged) s += ' {損傷}';
    return s;
  }

  return {
    MAX_ITEMS: MAX_ITEMS, SLOTS: SLOTS, SLOT_NAME: SLOT_NAME, slotEnabled: slotEnabled,
    equipBonus: equipBonus,
    create: create, capacity: capacity, totalWeight: totalWeight, speedPenalty: speedPenalty,
    add: add, consume: consume, remove: remove, sort: sort,
    equip: equip, unequip: unequip,
    weapon: weapon, totalAC: totalAC, totalSeal: totalSeal, lightRadius: lightRadius,
    label: label
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Inventory;
