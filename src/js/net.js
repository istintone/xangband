/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* net.js — 電脳層(縮小版)。docs/11 §11.1-11.3。DOM 非依存。
 *
 * 第2マップは作らない ([[D-65]])。狙いは一点だけ:
 *   **ネット面での行動が物理面に反映される。**
 *
 * 端末の上で接続し、認知(Cognition)を払って階そのものに干渉する。
 * ICE は敵ではなく**難度**として表す。
 *
 * 端末は安全な場所ではない。認知が尽きれば昏倒し、
 * **物理面の肉体が無防備になる** ―― ジャックインは常に「今ここで背中を晒す」判断。
 */
'use strict';

var Net = (function () {

  function ops() { return Data.get().netops; }
  function byId(id) { return Data.get().netopsById[id]; }

  /** 端末の上に立っているか。 */
  function atTerminal(W) {
    return World.getTile(W.level, W.player.x, W.player.y) === World.TILE.TERM;
  }

  /** この階でその操作が使えるか。使えない理由を返す(使えるなら null)。 */
  function blockReason(W, op) {
    var siteId = W.site ? W.site.id : null;
    if (op.sites && op.sites.indexOf(siteId) === -1) {
      return 'この設備には該当する系統が無い。';
    }
    if (W.netDone && W.netDone[op.id]) {
      return '既に通してある。もう変わらない。';
    }
    return null;
  }

  /** この階で使える操作の一覧(使えないものも理由付きで含める)。 */
  function listFor(W) {
    var all = ops();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      out.push({ op: all[i], blocked: blockReason(W, all[i]) });
    }
    return out;
  }

  /* ---------- ICE ---------- */

  /**
   * ICE 難度。深度で上がる。
   * 深度/3 では技能の伸びに追い越され、専門家の成功率が上限に張り付いた。
   * **深部では専門家でも確実ではない**ようにする ([[D-74]])。
   */
  function difficulty(W, op) {
    return op.ice + Math.floor(W.depth / 2);
  }

  /** 成功率(%)。接続技能がそのまま効く。 */
  function chance(W, op) {
    var skill = (W.player.skills && W.player.skills.net) || 0;
    return U.clamp(55 + skill - difficulty(W, op), 5, 95);
  }

  /* ---------- 接続 ---------- */

  /**
   * 接続して1つ通す。
   * @returns {object} { ok, reason, roll, dealt } dealt は消費した認知
   */
  function jack(W, opId) {
    var p = W.player;
    if (!atTerminal(W)) return { ok: false, reason: 'ここに端末は無い。' };

    var op = byId(opId);
    if (!op) return { ok: false, reason: 'そのような操作は無い。' };

    var blocked = blockReason(W, op);
    if (blocked) return { ok: false, reason: blocked };

    if (p.cog < op.cost) {
      return { ok: false, reason: '認知が足りない。(' + p.cog + '/' + op.cost + ')' };
    }

    spend(W, op.cost);
    var pct = chance(W, op);
    var roll = W.rng.int(100);
    World.msg(W, '接続した。' + op.name + '。');

    if (roll < pct) {
      run(W, op);
      if (!W.netDone) W.netDone = {};
      W.netDone[op.id] = true;
      return { ok: true, roll: roll, dealt: op.cost };
    }

    // 失敗。操作は起きない。認知を余分に持っていかれる。
    spend(W, op.fail);
    World.msg(W, 'ICE に弾かれた。');
    traced(W, roll, pct);
    return { ok: false, reason: 'ICE に弾かれた。', roll: roll, dealt: op.cost + op.fail };
  }

  /**
   * 認知を削る。0 になると昏倒する ([[doc:concept]] §0.4(3))。
   * HP ではなく認知を削るのが電脳層の定義そのもの。
   */
  function spend(W, amount) {
    var p = W.player;
    p.cog = Math.max(0, p.cog - amount);
    if (p.cog > 0) return;

    World.msg(W, '意識が飛んだ。');
    Actor.addTimer(p, 'paralyzed', W.rng.range(3, 6));
  }

  /** 大きく失敗すると逆探知される。監視のあるサイトでは補足に繋がる。 */
  function traced(W, roll, pct) {
    if (roll < pct + 25) return;                 // 惜しい失敗では起きない
    var env = Env.envOf(W);
    if (!env || env.surveillance <= 0) return;
    if (Site.hasAdaptation(W, 'watch')) return;
    if (W.alerted) return;
    W.alerted = true;
    W.alertLevel = 1;
    W.reinforceAt = W.turn + 40;
    World.msg(W, '逆探知された。位置が知られた。');
  }

  /* ---------- 物理面への反映 ---------- */

  var EFFECTS = {
    map: function (W) {
      var lv = W.level;
      for (var i = 0; i < lv.tiles.length; i++) lv.flags[i] |= World.F.KNOWN;
      World.msg(W, '階の形が頭に入った。');
    },

    manifest: function (W) {
      for (var i = 0; i < W.items.length; i++) {
        World.addFlag(W.level, W.items[i].x, W.items[i].y, World.F.KNOWN);
      }
      W.feeling.lootKnown = true;
      World.msg(W, W.items.length + ' 件の記録が残っている。');
    },

    bulkhead: function (W) {
      var lv = W.level;
      var opened = 0;
      for (var y = 0; y < lv.h; y++) {
        for (var x = 0; x < lv.w; x++) {
          if (World.getTile(lv, x, y) !== World.TILE.DOOR) continue;
          World.setTile(lv, x, y, World.TILE.FLOOR);
          opened++;
        }
      }
      World.msg(W, opened + ' 枚の隔壁が開いた。');
      // 方舟では気圧が動く。開けた側が得をするとは限らない ([[D-47]])
      if (lv.pressure) {
        Signature.floodPressure(lv, W.player.x, W.player.y,
                                Signature.pressureAt(W, W.player.x, W.player.y));
        World.msg(W, '区画をまたいで空気が動いている。');
      }
    },

    blind: function (W) {
      // これが「監視系の破壊」の実装 ([[doc:environment]] §8.3)
      Signature.clearAlert(W);
      W.netBlindUntil = W.turn + 400;
      World.msg(W, '走査系が自己診断に入った。しばらく見られていない。');
    },

    seize: function (W) {
      var n = 0;
      for (var i = 0; i < W.actors.length; i++) {
        var a = W.actors[i];
        if (a.kind !== 'monster' || a.dead) continue;
        if (a.base !== 'automata') continue;
        if (!World.hasFlag(W.level, a.x, a.y, World.F.VISIBLE)) continue;
        Actor.addTimer(a, 'paralyzed', W.rng.range(8, 16));
        n++;
      }
      World.msg(W, n ? n + ' 基が停止した。' : '応答する機械が無い。');
    }
  };

  function run(W, op) {
    var fx = EFFECTS[op.effect];
    if (fx) fx(W);
  }

  /** 監視を切っている間か。signature.js が見る。 */
  function isBlinded(W) {
    return !!(W.netBlindUntil && W.turn < W.netBlindUntil);
  }

  return {
    ops: ops, byId: byId, atTerminal: atTerminal, listFor: listFor,
    blockReason: blockReason, difficulty: difficulty, chance: chance,
    jack: jack, spend: spend, isBlinded: isBlinded, EFFECTS: EFFECTS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Net;
