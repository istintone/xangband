/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* ability.js — 能力(サブシステム)。docs/02 §2.10。DOM 非依存。
 *
 * 本家の呪文機構を踏襲する。名称だけがロールごとに変わる:
 *   psi 精神系(集中) / machine 機械系(帯域) / bio 生体系(血中濃度)
 */
'use strict';

var Ability = (function () {

  var SYSTEM_NAME = { psi: '集中', machine: '帯域', bio: '血中濃度' };
  var SYSTEM_LABEL = { psi: '精神系', machine: '機械系', bio: '生体系' };

  /**
   * SP の上限。主能力値とレベルから算出する。
   * 主能力値が低いと 0 になり、能力を一切使えない (本家準拠)。
   */
  function maxSP(p) {
    if (!p.system || !p.spStat) return 0;
    var stat = Stat.effective(p, p.spStat);
    var mult = Stat.spMult(stat);          // 1/10 単位
    if (mult <= 0) return 0;
    var sp = Math.floor(mult * p.level / 10);
    return Math.max(0, sp);
  }

  /** 習得できる能力数。レベルに比例する。 */
  function learnableCount(p) {
    if (!p.system) return 0;
    return Math.floor(p.level / 2) + 1;
  }

  /** そのロールが習得しうる能力の一覧 (レベル順)。 */
  function available(p) {
    var db = Data.get();
    return (p.abilityPool || []).map(function (id) { return db.abilitiesById[id]; })
      .filter(Boolean)
      .sort(function (a, b) { return a.level - b.level; });
  }

  /** いま習得できるもの (レベル条件を満たし、未習得)。 */
  function learnable(p) {
    return available(p).filter(function (a) {
      return a.level <= p.level && p.abilities.indexOf(a.id) === -1;
    });
  }

  function canLearnMore(p) {
    return p.abilities.length < learnableCount(p);
  }

  /** 習得は不可逆 ([[Q-15]] で組み替えを検討)。 */
  function learn(W, p, id) {
    if (!canLearnMore(p)) return { ok: false, reason: 'これ以上は習得できない。' };
    var a = Data.get().abilitiesById[id];
    if (!a) return { ok: false, reason: '未知の能力。' };
    if (a.level > p.level) return { ok: false, reason: 'レベルが足りない。' };
    if (p.abilities.indexOf(id) !== -1) return { ok: false, reason: 'すでに習得している。' };
    p.abilities.push(id);
    World.msg(W, '《' + a.name + '》を習得した。');
    return { ok: true };
  }

  /**
   * 失敗率 (docs/02 §2.10)。
   *   fail = 基礎 - 3*(レベル - 必要レベル) - 主能力値補正
   *   SP 不足なら +25。最低 5% / 最大 95%。
   */
  function failRate(p, a) {
    var fail = a.fail;
    fail -= 3 * (p.level - a.level);
    fail -= Stat.failBonus(Stat.effective(p, p.spStat));
    if (p.sp < a.cost) fail += 25;
    return U.clamp(fail, 5, 95);
  }

  /**
   * 能力を使う。
   * @returns {object} { ok, consumed, reason }
   */
  function use(W, p, id, target) {
    var a = Data.get().abilitiesById[id];
    if (!a) return { ok: false, reason: '未知の能力。' };
    if (p.abilities.indexOf(id) === -1) return { ok: false, reason: '習得していない。' };
    if (p.timers.confused > 0) return { ok: false, reason: '混乱していて集中できない。' };

    if (p.sp < a.cost) {
      // 本家同様、SP 不足でも試せる。ただし失敗率が跳ね上がり、消耗する。
      World.msg(W, SYSTEM_NAME[p.system] + 'が足りない。無理に試みる。');
    }

    var fail = failRate(p, a);
    p.sp = Math.max(0, p.sp - a.cost);

    if (W.rng.int(100) < fail) {
      World.msg(W, '《' + a.name + '》に失敗した。');
      return { ok: true, consumed: true, failed: true };
    }

    World.msg(W, '《' + a.name + '》。');
    Effect.apply(W, p, a.effect, target);
    return { ok: true, consumed: true, failed: false };
  }

  /** ゲームターンごとの SP 回復。 */
  function upkeep(W, p) {
    if (!p.system) return;
    p.spMax = maxSP(p);
    if (p.sp < p.spMax && W.turn % 15 === 0) {
      p.sp = Math.min(p.spMax, p.sp + 1 + Math.floor(p.level / 10));
    }
    if (p.sp > p.spMax) p.sp = p.spMax;
  }

  return {
    SYSTEM_NAME: SYSTEM_NAME, SYSTEM_LABEL: SYSTEM_LABEL,
    maxSP: maxSP, learnableCount: learnableCount,
    available: available, learnable: learnable, canLearnMore: canLearnMore,
    learn: learn, failRate: failRate, use: use, upkeep: upkeep
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Ability;
