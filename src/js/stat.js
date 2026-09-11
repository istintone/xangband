/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* stat.js — 能力値の 18/xx パーセンタイル ([[D-34]] / docs/02 §2.5)。DOM 非依存。
 *
 * 内部表現は単一の整数:
 *   3〜18  … そのまま
 *   19以上 … 18/10, 18/20, … を表す (内部値 v > 18 のとき 18/((v-18)*10))
 *   上限 40 = 18/220
 *
 * 表示だけが "18/50" の形になる。比較・加算は整数演算で済む。
 * 補正表は statIndex() で圧縮した添字で引く (本家 stat_ind と同じ考え方)。
 */
'use strict';

var Stat = (function () {

  var MIN = 3;
  var MAX = 40;            // 18/220
  var CAP18 = 18;

  /** 表示文字列。18 を超えると "18/xx" になる。 */
  function label(v) {
    v = clamp(v);
    if (v <= CAP18) return String(v);
    return '18/' + ((v - CAP18) * 10);
  }

  function clamp(v) { return v < MIN ? MIN : (v > MAX ? MAX : v); }

  /**
   * 補正表の添字。0 〜 (MAX-MIN)。
   * 3..18 が 0..15、18/10 以降が 16.. と続く。本家の stat_ind と同じ並び。
   */
  function index(v) { return clamp(v) - MIN; }
  var INDEX_MAX = MAX - MIN;

  /**
   * 補正表を引く。表は index 0..INDEX_MAX の配列で、短ければ末尾値を使う。
   * 表を毎回 38 要素書かずに済むよう、短い表を許す。
   */
  function lookup(table, v) {
    var i = index(v);
    return i < table.length ? table[i] : table[table.length - 1];
  }

  /* --- 補正表 (添字は index()。3,4,5,...,18,18/10,18/20,...) --- */

  /** 近接ダメージ補正 */
  var DAM = [-2,-2,-1,-1,0,0,0,0,0,0,1,1,2,2,3,4,  5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,20,20,20,20,20,20];
  /** 近接命中補正 */
  var HIT = [-3,-2,-2,-1,-1,0,0,0,0,0,0,1,1,2,2,3,  4,5,6,7,8,9,10,11,12,13,14,15,15,15,15,15,15,15,15,15,15,15];
  /** レベルごとの HP ボーナス (耐久) */
  var HP  = [-3,-2,-2,-1,-1,0,0,0,0,0,0,1,1,2,2,3,  3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13,14];
  /** 積載量の倍率 (1/10単位。体力) */
  var CARRY = [5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20, 22,24,26,28,30,32,34,36,38,40,42,44,46,48,50,52,54,56,58,60,62,64];
  /** SP の倍率 (1/10単位。主能力値) */
  var SP = [0,0,0,0,1,2,3,4,5,6,7,8,9,10,11,12,  13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,34];
  /** 能力の失敗率を下げる量 (主能力値) */
  var FAIL = [0,0,0,0,1,1,2,2,3,3,4,5,6,7,8,9,  10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
  /** 攻撃回数の元になる力 (体力) */
  var BLOW = [1,1,1,1,2,2,3,3,4,4,5,6,7,8,9,10, 11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32];

  var damBonus   = function (v) { return lookup(DAM, v); };
  var hitBonus   = function (v) { return lookup(HIT, v); };
  var hpBonus    = function (v) { return lookup(HP, v); };
  var carryMult  = function (v) { return lookup(CARRY, v); };
  var spMult     = function (v) { return lookup(SP, v); };
  var failBonus  = function (v) { return lookup(FAIL, v); };
  var blowPower  = function (v) { return lookup(BLOW, v); };

  /**
   * 能力値を1段階上げる。18 未満は +1、18 以降は 18/10 きざみ。
   * @returns {boolean} 実際に上がったら true
   */
  function raise(stats, key) {
    var v = stats[key];
    if (v >= MAX) return false;
    stats[key] = v + 1;
    return true;
  }

  /** 一時低下。母船で治療できる ([[D-08]]: 永久減少は作らない)。 */
  function drain(p, key, amount) {
    amount = amount || 1;
    if (!p.statDrain) p.statDrain = { str: 0, int: 0, wis: 0, dex: 0, con: 0, chr: 0 };
    p.statDrain[key] += amount;
    return true;
  }

  function restore(p) {
    p.statDrain = { str: 0, int: 0, wis: 0, dex: 0, con: 0, chr: 0 };
  }

  /** 実効値 = 素の値 + 装備補正 - 一時低下。 */
  function effective(p, key) {
    var base = p.stats[key];
    var bonus = (p.statBonus && p.statBonus[key]) || 0;
    var drained = (p.statDrain && p.statDrain[key]) || 0;
    return clamp(base + bonus - drained);
  }

  return {
    MIN: MIN, MAX: MAX, CAP18: CAP18, INDEX_MAX: INDEX_MAX,
    label: label, clamp: clamp, index: index, lookup: lookup,
    damBonus: damBonus, hitBonus: hitBonus, hpBonus: hpBonus,
    carryMult: carryMult, spMult: spMult, failBonus: failBonus, blowPower: blowPower,
    raise: raise, drain: drain, restore: restore, effective: effective
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Stat;
