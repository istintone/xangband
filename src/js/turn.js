/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* turn.js — エネルギー式ターンスケジューラ。DOM 非依存 ([[D-28]])。
 *
 * docs/02 §2.1:
 *   ゲームターンごとに全アクターへ energy += gain(speed)。
 *   energy >= 100 のアクターが行動し、行動コスト(通常100)を差し引く。
 *   速度 110 = 標準、+10 で行動回数2倍。
 *
 * プレイヤーと敵は同じ基盤で動かす (docs/01 不変条件5)。
 */
'use strict';

var Turn = (function () {

  var NORMAL_SPEED = 110;
  var ACTION_COST = 100;

  /* 本家 4.2 の extract_energy[] (docs/02 §2.1 の表)。
     index = 速度。110 で 10、120 で 20 (2倍)、130 で 30 (3倍)。
     109 -> 5 / 110 -> 10 の段差が「減速の恐ろしさ」を作っている。 */
  var ENERGY_TABLE = (function () {
    var t = new Uint8Array(200);
    var i;
    for (i = 0; i < 80; i++) t[i] = 1;                       // -30 以下
    for (i = 80; i < 90; i++) t[i] = 2;
    for (i = 90; i < 97; i++) t[i] = 2;
    for (i = 97; i < 100; i++) t[i] = 3;
    var slow = [3, 3, 4, 4, 4, 4, 5, 5, 5, 5];               // 100..109
    for (i = 0; i < 10; i++) t[100 + i] = slow[i];
    for (i = 0; i < 10; i++) t[110 + i] = 10 + i;            // 110..119
    for (i = 0; i < 10; i++) t[120 + i] = 20 + i;            // 120..129
    var f20 = [30, 31, 32, 33, 34, 35, 36, 36, 37, 37];      // 130..139
    for (i = 0; i < 10; i++) t[130 + i] = f20[i];
    var f30 = [38, 38, 39, 39, 40, 40, 40, 41, 41, 41];      // 140..149
    for (i = 0; i < 10; i++) t[140 + i] = f30[i];
    var f40 = [42, 42, 42, 43, 43, 43, 44, 44, 44, 44];      // 150..159
    for (i = 0; i < 10; i++) t[150 + i] = f40[i];
    for (i = 160; i < 200; i++) t[i] = Math.min(49, 45 + Math.floor((i - 160) / 10));
    return t;
  })();

  /** 速度 -> 1ゲームターンあたりの獲得エネルギー。 */
  function gain(speed) {
    var s = U.clamp(Math.round(speed), 0, 199);
    return ENERGY_TABLE[s];
  }

  /** 表示用の速度差 (+0 / +10 / -3)。 */
  function speedLabel(speed) {
    var d = Math.round(speed) - NORMAL_SPEED;
    return (d >= 0 ? '+' : '') + d;
  }

  /** 標準速度に対する行動回数の比。UI とバランス検証で使う。 */
  function speedRatio(speed) {
    return gain(speed) / gain(NORMAL_SPEED);
  }

  /* actFor の戻り値。エネルギーを誰が引くかを曖昧にしない。 */
  var STOP = false;   // 中断する (プレイヤーの入力待ち)。エネルギーは引かない
  var SKIP = 0;       // このアクターは外側が処理する。エネルギーは引かない
  var ACTED = true;   // 行動した。既定コストを引く
                      // 数値を返せばそのコストを引く (例: 素早い一撃 50)

  /**
   * 1ゲームターン進める。
   *
   * @param {object}   W       世界状態
   * @param {function} actFor  actor を受け取り STOP / SKIP / ACTED / コスト を返す。
   *                           **エネルギーを引くのは tick だけ**。呼び出し側で
   *                           二重に引かないよう、外側が処理するアクターには SKIP を返す。
   * @returns {boolean} STOP で中断したら false
   *
   * 行動順は energy の降順。同値なら配列順 (決定論を保つため乱数を使わない)。
   */
  function tick(W, actFor) {
    var actors = W.actors;
    var i;

    for (i = 0; i < actors.length; i++) {
      if (actors[i].dead) continue;
      actors[i].energy += gain(effectiveSpeed(actors[i]));
    }

    // 行動可能なものを先に取り出す。行動中に配列が変わりうる(敵の死亡)ため。
    var ready = [];
    for (i = 0; i < actors.length; i++) {
      if (!actors[i].dead && actors[i].energy >= ACTION_COST) ready.push(actors[i]);
    }
    ready.sort(function (a, b) { return b.energy - a.energy; });

    for (i = 0; i < ready.length; i++) {
      var a = ready[i];
      if (a.dead) continue;
      if (a.energy < ACTION_COST) continue;

      var r = actFor(a);
      if (r === STOP) return false;
      if (r === SKIP) continue;                       // 外側が引く
      a.energy -= (typeof r === 'number' && r > 0) ? r : ACTION_COST;
    }

    W.turn++;
    return true;
  }

  /** 一時効果を含めた実効速度。加速/減速はここで合成する。 */
  function effectiveSpeed(a) {
    var s = a.speed;
    if (a.timers && a.timers.haste > 0) s += 10;
    if (a.timers && a.timers.slow > 0) s -= 10;
    return s;
  }

  return {
    NORMAL_SPEED: NORMAL_SPEED, ACTION_COST: ACTION_COST,
    STOP: STOP, SKIP: SKIP, ACTED: ACTED,
    ENERGY_TABLE: ENERGY_TABLE,
    gain: gain, speedLabel: speedLabel, speedRatio: speedRatio,
    effectiveSpeed: effectiveSpeed,
    tick: tick
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Turn;
