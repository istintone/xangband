/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* ai.js — 敵の意思決定。DOM 非依存。
 *
 * docs/02 §2.9 の水準を目標にする。過剰に賢くしない ([[D-13]])。
 * 「物量と事故」が Angband の面白さなので、AI の賢さより数と多様性を優先する。
 *
 * 経路探索は本家式の**音のマップ(flow)** ([[D-35]])。
 * プレイヤー起点の BFS 距離マップを敵が下る。壁を回り込めるので、
 * 通路や角で待ち伏せる挙動が自然に出る。
 */
'use strict';

var AI = (function () {

  var SIGHT = 14;          // 視線での索敵半径
  var FLOW_MAX = 40;       // 音が届く距離。これを超えると寄ってこない
  var FLEE_HP_RATIO = 0.2;
  var UNREACHED = 65535;

  /* ---------- 音のマップ (flow) ---------- */

  /**
   * プレイヤーを起点に BFS で距離マップを作る。
   * 1階 6000マス程度なので、プレイヤーが動くたびに作り直しても軽い。
   */
  function computeFlow(W) {
    var lv = W.level;
    var n = lv.w * lv.h;
    var dist = new Uint16Array(n);
    for (var i = 0; i < n; i++) dist[i] = UNREACHED;

    var start = W.player.y * lv.w + W.player.x;
    dist[start] = 0;
    var queue = [start];
    var head = 0;

    while (head < queue.length) {
      var cur = queue[head++];
      var d = dist[cur];
      if (d >= FLOW_MAX) continue;
      var cx = cur % lv.w, cy = (cur - cx) / lv.w;

      for (var k = 0; k < U.DIRS.length; k++) {
        var nx = cx + U.DIRS[k].dx, ny = cy + U.DIRS[k].dy;
        if (!World.inBounds(lv, nx, ny)) continue;
        var ni = ny * lv.w + nx;
        if (dist[ni] !== UNREACHED) continue;
        if (!World.walkable(lv, nx, ny)) continue;
        dist[ni] = d + 1;
        queue.push(ni);
      }
    }
    W.flow = dist;
    return dist;
  }

  function flowAt(W, x, y) {
    if (!W.flow || !World.inBounds(W.level, x, y)) return UNREACHED;
    return W.flow[y * W.level.w + x];
  }

  /**
   * 敵からプレイヤーが見えるか。
   * プレイヤーと同じ視界判定を使う ([[D-29]])。
   * 「敵からは壁越しに見えている」という理不尽を作らない。
   */
  function canSee(W, mon, p) {
    if (U.distCheb(mon.x, mon.y, p.x, p.y) > SIGHT) return false;
    return FOV.lineOfSight(W.level, mon.x, mon.y, p.x, p.y);
  }

  function canStep(W, mon, x, y) {
    if (!World.walkable(W.level, x, y)) return false;
    var other = World.actorAt(W, x, y);
    return !other || other.kind === 'player';
  }

  /**
   * 音のマップを下って1歩。値が最も小さい隣接マスへ進む。
   * 同値なら配列順(決定論を保つため乱数を使わない)。
   */
  function stepByFlow(W, mon) {
    var here = flowAt(W, mon.x, mon.y);
    if (here === UNREACHED) return null;

    var best = null, bestD = here;
    for (var k = 0; k < U.DIRS.length; k++) {
      var d = U.DIRS[k];
      var nx = mon.x + d.dx, ny = mon.y + d.dy;
      if (!canStep(W, mon, nx, ny)) continue;
      var v = flowAt(W, nx, ny);
      if (v < bestD) { bestD = v; best = [d.dx, d.dy]; }
    }
    return best;
  }

  /** 音のマップを**登る** = プレイヤーから遠ざかる。 */
  function stepAwayByFlow(W, mon) {
    var here = flowAt(W, mon.x, mon.y);
    var best = null, bestD = here === UNREACHED ? -1 : here;
    for (var k = 0; k < U.DIRS.length; k++) {
      var d = U.DIRS[k];
      var nx = mon.x + d.dx, ny = mon.y + d.dy;
      if (!canStep(W, mon, nx, ny)) continue;
      var v = flowAt(W, nx, ny);
      if (v !== UNREACHED && v > bestD) { bestD = v; best = [d.dx, d.dy]; }
    }
    return best;
  }

  /** ランダムな1歩 (不規則移動・徘徊)。 */
  function stepRandom(W, mon) {
    var dirs = W.rng.shuffle(U.DIRS.slice());
    for (var i = 0; i < dirs.length; i++) {
      if (canStep(W, mon, mon.x + dirs[i].dx, mon.y + dirs[i].dy)) {
        return [dirs[i].dx, dirs[i].dy];
      }
    }
    return null;
  }

  /* ---------- 睡眠と覚醒 ([[D-40]]) ---------- */

  /**
   * プレイヤーの騒音。隠密技能が高いほど小さい。
   * 距離で減衰し、視界内なら倍になる。
   */
  function noiseFor(W, mon, sees) {
    var stealth = (W.player.skills && W.player.skills.stealth) || 0;
    var noise = Math.max(1, 30 - stealth);
    var dist = U.distCheb(mon.x, mon.y, W.player.x, W.player.y);
    var n = noise / (1 + dist);
    if (sees) n *= 2;
    // 汚染ファーム「発信」は位置を発信し続ける
    if (W.player.equipBonus && W.player.equipBonus.noise > 0) n *= 3;
    return n;
  }

  /**
   * 覚醒判定。一度起きた敵は二度と眠らない。
   * @returns {boolean} 起きていれば true
   */
  function wakeCheck(W, mon, sees) {
    if (mon.asleep <= 0) return true;
    mon.asleep -= noiseFor(W, mon, sees);
    if (mon.asleep <= 0) {
      mon.asleep = 0;
      if (World.hasFlag(W.level, mon.x, mon.y, World.F.VISIBLE)) {
        World.msg(W, mon.name + 'が気づいた。');
      }
      return true;
    }
    return false;
  }

  /**
   * 1体ぶんの行動。
   * @returns {boolean} 常に true (敵は必ずターンを消費する)
   */
  function act(W, mon) {
    var p = W.player;

    if (!Actor.canAct(mon)) return true;        // 麻痺など

    var sees = canSee(W, mon, p);
    if (!wakeCheck(W, mon, sees)) return true;  // 眠っている
    if (sees) Lore.noteSeen(W, mon);

    // 逃走判定。COWARD は早めに、NO_FEAR は絶対に逃げない。
    if (!Monster.hasFlag(mon, 'NO_FEAR')) {
      var ratio = mon.hp / mon.hpMax;
      var threshold = Monster.hasFlag(mon, 'COWARD') ? 0.4 : FLEE_HP_RATIO;
      mon.fleeing = ratio < threshold || mon.timers.afraid > 0;
    }

    /* 遠隔。射線が通っていれば、隣接していても撃つ(本家と同じ)。
       撃った手番は移動も殴打もしない ([[D-68]])。 */
    if (sees && !mon.fleeing && Combat.willCast(W, mon)) {
      Combat.monsterCast(W, mon, p);
      return true;
    }

    var adjacent = U.distCheb(mon.x, mon.y, p.x, p.y) === 1;
    if (adjacent && !mon.fleeing) {
      Combat.monsterAttack(W, mon, p);
      return true;
    }

    var step = null;

    if (mon.fleeing) {
      step = stepAwayByFlow(W, mon);
      if (!step && adjacent) {                  // 逃げ場が無いなら反撃
        Combat.monsterAttack(W, mon, p);
        return true;
      }
      if (!step) step = stepRandom(W, mon);
    } else if (mon.timers.confused > 0) {
      step = stepRandom(W, mon);                // 混乱中は方向が定まらない
    } else if (Monster.hasFlag(mon, 'ERRATIC') && W.rng.oneIn(3)) {
      step = stepRandom(W, mon);                // 不規則移動
    } else {
      // 音のマップを下る。届いていなければ徘徊する。
      step = stepByFlow(W, mon);
      if (!step && W.rng.oneIn(2)) step = stepRandom(W, mon);
    }

    if (step) {
      var nx = mon.x + step[0], ny = mon.y + step[1];
      var other = World.actorAt(W, nx, ny);
      if (other && other.kind === 'player') {
        Combat.monsterAttack(W, mon, p);
      } else {
        mon.x = nx; mon.y = ny;
      }
    }
    return true;
  }

  return {
    SIGHT: SIGHT, FLOW_MAX: FLOW_MAX, UNREACHED: UNREACHED,
    computeFlow: computeFlow, flowAt: flowAt,
    noiseFor: noiseFor, wakeCheck: wakeCheck,
    act: act, canSee: canSee,
    stepByFlow: stepByFlow, stepAwayByFlow: stepAwayByFlow
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AI;
