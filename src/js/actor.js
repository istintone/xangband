/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* actor.js — アクター共通の基盤。DOM 非依存。
 *
 * プレイヤーと敵はここを共有する (docs/01 不変条件5)。
 * 速度・状態異常・HP の扱いを左右で二重実装しない。
 */
'use strict';

var Actor = (function () {

  /* 状態異常の上限ターン (docs/02 §2.7 — 本家の理不尽さを緩和する [[D-08]])。 */
  var TIMER_CAP = {
    poison: 60, confused: 20, afraid: 40, paralyzed: 6,
    blind: 40, haste: 100, slow: 60, bound: 40
  };

  function create(props) {
    var a = {
      id: 0,
      kind: 'monster',        // 'player' | 'monster'
      x: 0, y: 0,
      hp: 1, hpMax: 1,
      speed: Turn.NORMAL_SPEED,
      energy: 0,
      actionCost: 0,
      ac: 0,
      dead: false,
      timers: { poison: 0, confused: 0, afraid: 0, paralyzed: 0, blind: 0, haste: 0, slow: 0,
                bound: 0 }
    };
    for (var k in props) a[k] = props[k];
    return a;
  }

  /** 状態異常を付与する。上限を超えない。 */
  function addTimer(a, name, turns) {
    if (!(name in a.timers)) throw new Error('未知の状態異常: ' + name);
    var cap = TIMER_CAP[name] || 100;
    a.timers[name] = Math.min(cap, a.timers[name] + turns);
  }

  function hasTimer(a, name) { return a.timers[name] > 0; }

  /** ゲームターンごとの減衰。turn.js の upkeep から呼ぶ。 */
  function tickTimers(a) {
    for (var k in a.timers) if (a.timers[k] > 0) a.timers[k]--;
  }

  /**
   * ダメージを与える。死んだら true。
   * 死亡の後処理(経験値・ドロップ・除去)は呼び出し側が行う。
   */
  function damage(a, amount) {
    a.hp -= Math.max(0, amount);
    if (a.hp <= 0) { a.hp = 0; a.dead = true; return true; }
    return false;
  }

  /**
   * 回復。**死者は蘇生しない。**
   * これが無いと「死亡フラグが立ったまま HP が戻る」ゾンビ状態が生まれ、
   * スケジューラが死者を飛ばすためターンが永久に進まなくなる。
   */
  function heal(a, amount) {
    if (a.dead) return;
    a.hp = Math.min(a.hpMax, a.hp + Math.max(0, amount));
  }

  /** 行動できるか。麻痺中は行動を飛ばす。 */
  function canAct(a) { return !a.dead && a.timers.paralyzed === 0; }

  return {
    TIMER_CAP: TIMER_CAP,
    create: create,
    addTimer: addTimer, hasTimer: hasTimer, tickTimers: tickTimers,
    damage: damage, heal: heal, canAct: canAct
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Actor;
