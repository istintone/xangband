/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* lore.js — 敵の知識 (monster memory)。docs/02 §2.11。DOM 非依存。
 *
 * 倒すほど、殴られるほど、その敵について分かることが増える。
 * 知識はランを跨がない (パーマデスなので毎回ゼロから — [[Q-14]] で再検討)。
 */
'use strict';

var Lore = (function () {

  function create() { return {}; }

  function entry(W, raceId) {
    if (!W.lore[raceId]) {
      W.lore[raceId] = { seen: 0, kills: 0, blows: {}, drops: 0, damageTaken: 0, attacked: 0 };
    }
    return W.lore[raceId];
  }

  /** 視界に入った。 */
  function noteSeen(W, mon) {
    var e = entry(W, mon.raceId);
    e.seen++;
  }

  /** その攻撃を受けた → 攻撃手段と効果が分かる。 */
  function noteBlow(W, mon, blow) {
    var e = entry(W, mon.raceId);
    var key = blow.method + ':' + blow.effect;
    e.blows[key] = (e.blows[key] || 0) + 1;
  }

  /** その遠隔攻撃を見た → 次から予期できる ([[D-68]])。 */
  function noteSpell(W, mon, spec) {
    var e = entry(W, mon.raceId);
    if (!e.spells) e.spells = {};
    e.spells[spec] = (e.spells[spec] || 0) + 1;
  }

  /** こちらが殴った → 回数を数える。一定以上で HP の見当がつく。 */
  function noteAttacked(W, mon) {
    if (!mon.raceId) return;
    entry(W, mon.raceId).attacked++;
  }

  function noteKill(W, mon) {
    var e = entry(W, mon.raceId);
    e.kills++;
  }

  function noteDrop(W, mon) {
    entry(W, mon.raceId).drops++;
  }

  /** HP の見当がつくか (一定回数倒したら)。 */
  function knowsHP(W, raceId) {
    var e = W.lore[raceId];
    return !!e && e.kills >= 3;
  }

  /**
   * 表示用の知識テキスト。分かっていることだけを並べる。
   * 分かっていないことは書かない = 「まだ知らない」がプレイヤーに伝わる。
   */
  function describe(W, raceId) {
    var race = Data.get().monstersById[raceId];
    if (!race) return null;
    var e = W.lore[raceId];
    var lines = [];

    lines.push(race.name + '  (' + Data.get().monsterBase[race.base].name + ')');
    if (race.desc) lines.push(race.desc);
    lines.push('');

    if (!e || e.seen === 0) { lines.push('まだ何も分かっていない。'); return lines; }

    lines.push('遭遇 ' + e.seen + ' 回 / 撃破 ' + e.kills + ' 体');

    if (knowsHP(W, raceId)) {
      lines.push('体力: およそ ' + Math.round(Data.diceAvg(race.hp)) + '  防御: ' + race.ac);
      lines.push('速度: ' + Turn.speedLabel(race.speed) + '  深度: ' + race.depth + ' 以深');
    } else {
      lines.push('体力: 不明 (あと ' + Math.max(0, 3 - e.kills) + ' 体倒せば分かる)');
    }

    var known = Object.keys(e.blows);
    if (known.length) {
      lines.push('');
      lines.push('確認した攻撃:');
      for (var i = 0; i < known.length; i++) {
        var parts = known[i].split(':');
        var verb = Combat.METHOD_VERB[parts[0]] || parts[0];
        var eff = EFFECT_NAME[parts[1]] || parts[1];
        lines.push('  ' + verb.replace('てきた', 'る') + ' (' + eff + ')');
      }
      if (known.length < (race.blows || []).length) {
        lines.push('  …他にもありそうだ。');
      }
    }
    if (e.drops > 0) lines.push('', '何かを落とすことがある。');
    return lines;
  }

  var EFFECT_NAME = {
    hurt: '物理', taint: '汚染', acid: '腐食', fire: '高熱', cold: '極低温',
    elec: '電磁', rad: '放射', psi: '精神', 'drain-cell': '電力吸収',
    confuse: '混乱', paralyze: '麻痺'
  };

  return {
    create: create, entry: entry,
    noteSeen: noteSeen, noteBlow: noteBlow, noteSpell: noteSpell,
    noteAttacked: noteAttacked,
    noteKill: noteKill, noteDrop: noteDrop,
    knowsHP: knowsHP, describe: describe, EFFECT_NAME: EFFECT_NAME
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Lore;
