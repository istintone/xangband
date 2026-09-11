/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* combat.js — 戦闘。近接と遠隔。DOM 非依存。
 *
 * docs/02 §2.6 の式をそのまま実装する。本家 test_hit() の構造を写している。
 * 能力値は 18/xx 対応 (stat.js) ([[D-34]])。
 */
'use strict';

var Combat = (function () {

  /**
   * 命中判定 (本家 test_hit)。
   *   1) 5% の確率で「揺らぎ」に入り、そのうち 12% だけ命中する
   *   2) power <= 0 なら必ず外れる
   *   3) それ以外は rand(0..power-1) >= floor(ac*2/3)
   *
   * AC の 2/3 しか見ないので、AC を積んでも命中率は 0 に漸近するだけ。
   */
  function testHit(rng, power, ac) {
    if (rng.int(100) < 5) return rng.int(100) < 12;
    if (power <= 0) return false;
    return rng.int(power) >= Math.floor(ac * 2 / 3);
  }

  /**
   * 攻撃回数 (docs/02 §2.6)。
   *   power = 体力の攻撃力 + 反射の攻撃力
   *   blows = clamp(1 + floor(power*8 / (武器重量+100)), 1, ロール上限)
   * 軽い武器ほど多く振れる。
   */
  function blowsFor(p, weapon) {
    var weight = weapon ? (weapon.weight || 0) : 0;
    var power = Stat.blowPower(statOf(p, 'str')) + Stat.blowPower(statOf(p, 'dex'));
    var n = 1 + Math.floor(power * 8 / (weight + 100));
    return U.clamp(n, 1, p.maxBlows || 1);
  }

  /** 実効能力値。プレイヤーなら装備補正込み、敵なら固定。 */
  function statOf(a, key) {
    if (!a.stats) return 10;
    return a.kind === 'player' ? Stat.effective(a, key) : a.stats[key];
  }

  /**
   * クリティカル。命中したときに追加ダメージを判定する。
   * 軽い武器のほうが出やすい本家の性質を保つ。
   */
  function critical(rng, weight, toHit, level) {
    var chance = weight + toHit * 4 + level * 2 + 20;
    if (!rng.oneIn(Math.max(2, Math.floor(5000 / Math.max(1, chance))))) {
      return { mult: 1, label: null };
    }
    var power = rng.range(1, 100) + weight;
    if (power < 40) return { mult: 2, label: '会心' };
    if (power < 120) return { mult: 2, label: '痛烈' };
    return { mult: 3, label: '致命' };
  }

  /* ---------- スレイ / ブランド (docs/02 §2.6) ---------- */

  /** 敵がその属性に耐性を持つか。系統から導く。 */
  function monsterResists(mon, element) {
    var base = mon.base;
    if (element === 'pois' && (base === 'automata' || base === 'aberrant')) return true;
    if (element === 'psi' && (base === 'automata')) return true;
    if (element === 'elec' && base === 'aberrant') return true;
    if (element === 'rad' && (base === 'automata' || base === 'aberrant')) return true;
    return false;
  }

  /**
   * その敵にスレイが通るか ([[D-92]])。
   *
   * スレイは「相手が**何であるか**」に賭ける刻印。
   * 《異常》(`aberrant`) は**分類できないもの**なので、分類に基づく倍率が当たらない
   * ([[doc:content]] §3.4)。設定どおりの帰結であって、後付けの制約ではない。
   *
   * これが無いと、深部は `aberrant` が最多(深度70-100 で 10/21体)なので
   * **終盤が「対異常を引いたか」の抽選**になる ―― 実測で《門番》が3手で沈んでいた。
   * ブランド(属性)は効く。属性は分類ではなく現象だから。
   */
  function slayable(mon) {
    var base = Data.get().monsterBase[mon.base];
    return !base || base.slayable !== false;
  }

  /**
   * 装備の刻印から、この敵に対する最大倍率を求める。
   * 本家同様、スレイとブランドは**重ならず、最大のもの1つだけ**が効く。
   */
  function bestMultiplier(bonus, mon) {
    var best = 1, used = null;
    if (slayable(mon)) {
      for (var i = 0; i < bonus.slay.length; i++) {
        var s = bonus.slay[i];
        if (s.base === mon.base && s.mult > best) { best = s.mult; used = 'slay:' + s.base; }
      }
    }
    for (var j = 0; j < bonus.brand.length; j++) {
      var el = bonus.brand[j];
      if (monsterResists(mon, el)) continue;
      if (2 > best) { best = 2; used = 'brand:' + el; }
    }
    return { mult: best, used: used };
  }

  /**
   * プレイヤーの近接攻撃 1ターン分。攻撃回数ぶん繰り返す。
   * @returns {object} { hits, misses, damage, killed, crits, mult }
   */
  function playerAttack(W, p, target, weapon) {
    var rng = W.rng;
    var blows = blowsFor(p, weapon);
    var bonus = p.equipBonus || Sigil.collect([], 0);
    var toHit = (weapon ? (weapon.toHit || 0) : 0) + Stat.hitBonus(statOf(p, 'dex'));
    var power = (p.skills ? p.skills.melee : 20) + toHit * 3;

    var res = { hits: 0, misses: 0, damage: 0, killed: false, crits: [], mult: 1 };
    var m = bestMultiplier(bonus, target);
    res.mult = m.mult;

    // 眠っている敵への攻撃は必ず命中し、不意打ちの倍率が乗る ([[D-40]])
    var sneak = target.asleep > 0;
    if (sneak) { res.sneak = true; target.asleep = 0; }

    for (var i = 0; i < blows; i++) {
      if (target.dead) break;

      if (!sneak && !testHit(rng, power, target.ac)) { res.misses++; continue; }
      res.hits++;

      var dmg = weapon
        ? Data.rollDice(rng, weapon.dice)
        : rng.dice(1, 3);                       // 素手

      // 倍率は**ダイスにだけ**掛かる (本家準拠。固定ボーナスには乗らない)
      if (m.mult > 1) {
        dmg *= m.mult;
        // その敵を殴ったことで、条件付きの刻印が判明する
        Sigil.reveal(W, weapon, 'hit', { base: target.base });
      }
      dmg += (weapon ? (weapon.toDam || 0) : 0) + Stat.damBonus(statOf(p, 'str'));
      // 重力が近接に効く。低重力では踏ん張れない (docs/08 §8.3)。
      var gmod = Env.meleeMod(Env.envOf(W));
      if (gmod !== 100) dmg = Math.round(dmg * gmod / 100);

      var crit = critical(rng, weapon ? weapon.weight : 0, toHit, p.level);
      if (crit.label) { dmg *= crit.mult; res.crits.push(crit.label); }
      // 不意打ちは1発目にだけ乗る。隠密が高いロールの主軸になる。
      if (sneak && i === 0) dmg = Math.floor(dmg * (1 + (p.skills.stealth || 0) / 4));

      dmg = Math.max(1, dmg);
      res.damage += dmg;
      Lore.noteAttacked(W, target);
      if (Actor.damage(target, dmg)) { res.killed = true; break; }
    }
    return res;
  }

  /**
   * 遠隔攻撃 (docs/02 §2.6)。
   *   ダメージ = (弾体ダイス + 弾体toDam + 射出器toDam) * 倍率
   *   倍率は最後に掛かる = 射出器の質がダメージを支配する。
   */
  function rangedAttack(W, p, target, launcher, ammo) {
    var rng = W.rng;
    var mult = launcher.mult || 1;
    var toHit = (launcher.toHit || 0) + (ammo.toHit || 0) + Stat.hitBonus(statOf(p, 'dex'));
    var power = (p.skills ? p.skills.shoot : 20) + toHit * 3;

    var res = { hit: false, damage: 0, killed: false, crits: [], broke: false };

    if (!testHit(rng, power, target.ac)) return res;
    res.hit = true;

    var dmg = Data.rollDice(rng, ammo.dice) + (ammo.toDam || 0) + (launcher.toDam || 0);
    dmg = dmg * mult;

    var bonus = p.equipBonus || Sigil.collect([], 0);
    var m = bestMultiplier(bonus, target);
    if (m.mult > 1) dmg = Math.floor(dmg * m.mult);

    var crit = critical(rng, ammo.weight || 0, toHit, p.level);
    if (crit.label) { dmg *= crit.mult; res.crits.push(crit.label); }

    dmg = Math.max(1, dmg);
    res.damage = dmg;
    Lore.noteAttacked(W, target);
    if (Actor.damage(target, dmg)) res.killed = true;
    return res;
  }

  /** 射程。倍率が高いほど遠くまで届く。 */
  function rangeOf(launcher) {
    return Math.min(20, 10 * (launcher.mult || 1) / 2 + 5) | 0;
  }

  /* 敵の攻撃効果。HP減以外の効果はここで解決する (docs/02 §2.6)。 */
  var EFFECTS = {
    hurt: function () { /* ダメージのみ */ },
    taint: function (W, p) {
      if (resisted(p, 'pois')) return;
      if (W.rng.oneIn(3)) { Actor.addTimer(p, 'poison', 8); World.msg(W, '汚染された。'); }
    },
    acid: function (W, p) {
      if (resisted(p, 'acid')) return;
      if (W.rng.oneIn(4)) damageEquip(W, p, 'acid');
    },
    fire: function (W, p) {
      if (resisted(p, 'fire')) return;
      if (W.rng.oneIn(5)) damageEquip(W, p, 'fire');
    },
    cold: function (W, p) { if (!resisted(p, 'cold') && W.rng.oneIn(6)) Actor.addTimer(p, 'slow', 5); },
    elec: function (W, p) {
      if (resisted(p, 'elec')) return;
      var lost = Math.min(p.cells, W.rng.range(5, 20));
      if (lost > 0) { p.cells -= lost; World.msg(W, '電装がショートした。'); }
    },
    rad: function (W, p) {
      if (resisted(p, 'rad')) return;
      p.exposure = (p.exposure || 0) + W.rng.range(1, 3);
      if (p.exposure > 20 && W.rng.oneIn(3)) {
        var key = W.rng.pick(['str', 'dex', 'con']);
        Stat.drain(p, key, 1);
        World.msg(W, '被曝が進んでいる。');
      }
    },
    psi: function (W, p) {
      if (resisted(p, 'psi')) return;
      if (W.rng.oneIn(3)) { Actor.addTimer(p, 'confused', 6); World.msg(W, '思考が乱れた。'); }
    },
    'drain-cell': function (W, p) {
      var lost = Math.min(p.cells, W.rng.range(10, 40));
      if (lost > 0) { p.cells -= lost; World.msg(W, 'セルから電力が吸い出された。'); }
    },
    confuse: function (W, p) {
      if (W.rng.oneIn(2)) { Actor.addTimer(p, 'confused', 6); World.msg(W, '混乱した。'); }
    },
    paralyze: function (W, p) {
      if (p.equipBonus && p.equipBonus.freeAction) { World.msg(W, '自律制御が働いた。'); return; }
      if (W.rng.oneIn(2)) { Actor.addTimer(p, 'paralyzed', 3); World.msg(W, '身体が固まった。'); }
    }
  };

  function resisted(p, element) {
    return !!(p.equipBonus && p.equipBonus.resist && p.equipBonus.resist[element]);
  }

  /** 装備を1点損傷させる。AC が下がり、直すには母船が要る。 */
  function damageEquip(W, p, element) {
    var slots = Inventory.SLOTS.filter(function (s) {
      var e = W.inv.equip[s];
      return e && (e.ac || 0) > 0;
    });
    if (slots.length === 0) return;
    var slot = W.rng.pick(slots);
    var it = W.inv.equip[slot];
    it.ac = Math.max(0, it.ac - 1);
    it.damaged = (it.damaged || 0) + 1;
    World.msg(W, Sigil.name(W.knowledge, it) + 'が損傷した。');
  }

  var METHOD_VERB = {
    hit: '殴りかかってきた', claw: '引き裂いてきた', bite: '噛みついてきた',
    touch: '触れてきた', crush: '押し潰してきた'
  };

  /* ================= 敵の遠隔攻撃 ([[D-68]] / docs/02 §2.9.1) =================
   *
   * 本家の spell_freq (1_IN_X) をそのまま踏襲する。
   * 近接しかない敵しか居ないと、深部が「殴り合いの数字比べ」に収束する。
   * プレイヤー側には既に射出器と能力があるので、敵側にも同じ軸を返す。
   *
   * 書式は "種別:引数:引数"。data 側で1行に収まることを優先している。
   */

  /**
   * その敵が今撃てる遠隔の一覧。
   * **呼ばれて来た敵は召喚できない** ([[D-90]]) ―― 連鎖を一世代で止める。
   * 階が満員のときも同じ扱いにする(撃てない呪文を選んで手番を捨てさせない)。
   * @returns {Array|null} 撃てるものが無ければ null
   */
  function castable(W, mon) {
    var sp = mon.spells;
    if (!sp || !sp.list || !sp.list.length) return null;
    if (!mon.summoned && !Monster.atCapacity(W)) return sp.list;
    var out = [];
    for (var i = 0; i < sp.list.length; i++) {
      if (sp.list[i].indexOf('summon') !== 0) out.push(sp.list[i]);
    }
    return out.length ? out : null;
  }

  /** その敵は今この手番に遠隔を撃つか。射線が通っていることが前提。 */
  function willCast(W, mon) {
    if (mon.timers && mon.timers.confused > 0) return false;  // 混乱中は撃てない
    if (!castable(W, mon)) return false;
    return W.rng.oneIn(mon.spells.freq || 5);
  }

  /**
   * 遠隔を1つ撃つ。**撃った手番は移動も殴打もしない**(本家と同じ)。
   * @returns {object} { spell, damage } 何を撃ったか
   */
  function monsterCast(W, mon, p) {
    var spec = W.rng.pick(castable(W, mon) || mon.spells.list);
    var parts = spec.split(':');
    var kind = parts[0];
    var res = { spell: spec, damage: 0 };

    if (kind === 'bolt')        res.damage = castBolt(W, mon, p, parts[1], parts[2]);
    else if (kind === 'breath') res.damage = castBreath(W, mon, p, parts[1], parts[2]);
    else if (kind === 'status') castStatus(W, mon, p, parts[1]);
    else if (kind === 'summon') castSummon(W, mon, parts[1]);
    else if (kind === 'heal')   castHeal(W, mon, parts[1]);
    else if (kind === 'blink')  castBlink(W, mon, parts[1]);

    Lore.noteSpell(W, mon, spec);
    return res;
  }

  /** 環境属性は《適合》で完全に無効になる ([[doc:endgame]] §7.2)。 */
  var ADAPT_FOR = { vacuum: 'vacuum', rad: 'radiation', taint: 'contamination', watch: 'watch' };

  function adapted(W, element) {
    var kind = ADAPT_FOR[element];
    return !!kind && typeof Site !== 'undefined' && Site.hasAdaptation(W, kind);
  }

  var ELEMENT_NAME = {
    fire: '熱線', cold: '冷却流', elec: '放電', acid: '腐食', pois: '毒素',
    rad: '放射', psi: '思念', taint: '汚染物', vacuum: '減圧波', watch: '走査'
  };

  function elementName(e) { return ELEMENT_NAME[e] || e; }

  function hurtPlayer(W, mon, p, dmg, element) {
    if (dmg <= 0) return 0;
    if (resisted(p, element)) dmg = Math.max(1, Math.floor(dmg / 3));
    var fx = EFFECTS[element];
    if (fx) fx(W, p);
    revealOnHurt(W, element);
    W.lastAttacker = mon.name;
    if (W.tally) W.tally.foe += dmg;
    Actor.damage(p, dmg);
    return dmg;
  }

  function castBolt(W, mon, p, element, dice) {
    if (adapted(W, element)) {
      World.msg(W, mon.name + 'の' + elementName(element) + 'は、あなたに届かない。');
      return 0;
    }
    var dmg = Data.rollDice(W.rng, dice);
    World.msg(W, mon.name + 'が' + elementName(element) + 'を撃った。');
    return hurtPlayer(W, mon, p, dmg, element);
  }

  /* ブレスは本家同様「撃つ側の現在HPの割合」。弱った敵のブレスは弱い。 */
  function castBreath(W, mon, p, element, pct) {
    var dmg = Math.max(1, Math.floor(mon.hp * (parseInt(pct, 10) || 20) / 100));
    dmg = Math.min(dmg, BREATH_CAP);
    if (adapted(W, element)) {
      World.msg(W, mon.name + 'が' + elementName(element) + 'を吐いた。あなたは既に適合している。');
      return 0;
    }
    World.msg(W, mon.name + 'が' + elementName(element) + 'を吐いた。');
    return hurtPlayer(W, mon, p, dmg, element);
  }

  var BREATH_CAP = 160;          // 本家と同じく上限を置く。事故死を青天井にしない

  function castStatus(W, mon, p, name) {
    if (name === 'watch') {                      // 監視は「呼ぶ」。ダメージではない
      if (adapted(W, 'watch')) {
        World.msg(W, mon.name + 'があなたを走査したが、認識されない。');
        return;
      }
      World.msg(W, mon.name + 'があなたを走査した。位置が知られた。');
      castSummon(W, mon, '2');
      return;
    }
    if (p.equipBonus && p.equipBonus.freeAction && (name === 'paralyzed' || name === 'slow')) {
      World.msg(W, '自律制御が働いた。');
      return;
    }
    Actor.addTimer(p, name, W.rng.range(4, 10));
    World.msg(W, mon.name + 'の干渉を受けた。');
  }

  function castSummon(W, mon, n) {
    var count = parseInt(n, 10) || 1;
    var made = Monster.summonNear(W, mon, count, W.level.depth);
    World.msg(W, made ? mon.name + 'が仲間を呼んだ。' : mon.name + 'が呼んだが、誰も来なかった。');
  }

  function castHeal(W, mon, pct) {
    var amount = Math.floor(mon.hpMax * (parseInt(pct, 10) || 25) / 100);
    var before = mon.hp;
    Actor.heal(mon, amount);
    if (mon.hp > before) World.msg(W, mon.name + 'の損傷が塞がっていく。');
  }

  function castBlink(W, mon, dist) {
    // 《係留》は逃げ道だけを塞ぐ。行動は奪わない ([[D-95]])。
    if (mon.timers && mon.timers.bound > 0) {
      World.msg(W, mon.name + 'が転移しようとしたが、座標が埋まっている。');
      return;
    }
    Effect.teleport(W, mon, parseInt(dist, 10) || 8);
    World.msg(W, mon.name + 'が位置を変えた。');
  }

  /** 敵の近接攻撃 1ターン分。 */
  function monsterAttack(W, mon, p) {
    var rng = W.rng;
    var blows = mon.blows || [];
    var res = { hits: 0, damage: 0, killed: false };

    for (var i = 0; i < blows.length; i++) {
      if (p.dead) break;
      var b = blows[i];
      var power = mon.level * 3 + 20;

      if (!testHit(rng, power, p.ac)) {
        World.msg(W, mon.name + 'の攻撃を避けた。');
        continue;
      }
      res.hits++;

      var dmg = Math.max(1, Data.rollDice(rng, b.dice));
      // 防具は当たりにくさに加えて、わずかに軽減もする
      dmg = Math.max(1, dmg - Math.floor(p.ac / 12));
      // 耐性があれば大きく減る
      if (resisted(p, b.effect)) dmg = Math.max(1, Math.floor(dmg / 3));
      // 汚染ファーム「脆性」は被ダメを増やす
      if (p.equipBonus && p.equipBonus.fragile > 0) dmg = Math.floor(dmg * 1.25);
      res.damage += dmg;

      World.msg(W, mon.name + 'が' + (METHOD_VERB[b.method] || '攻撃してきた') + '。');
      Lore.noteBlow(W, mon, b);

      var fx = EFFECTS[b.effect];
      if (fx) fx(W, p);
      // 被弾で耐性の刻印が判明する (docs/02 §2.8)
      revealOnHurt(W, b.effect);

      W.lastAttacker = mon.name;
      if (W.tally) W.tally.foe += dmg;              // [[D-53]] の指標
      if (Actor.damage(p, dmg)) { res.killed = true; break; }
    }
    return res;
  }

  function revealOnHurt(W, element) {
    for (var i = 0; i < Inventory.SLOTS.length; i++) {
      var it = W.inv.equip[Inventory.SLOTS[i]];
      if (it) Sigil.reveal(W, it, 'hurt', { element: element });
    }
  }

  return {
    testHit: testHit, blowsFor: blowsFor, statOf: statOf, critical: critical,
    monsterResists: monsterResists, bestMultiplier: bestMultiplier, slayable: slayable,
    playerAttack: playerAttack, rangedAttack: rangedAttack, rangeOf: rangeOf,
    monsterAttack: monsterAttack, resisted: resisted, damageEquip: damageEquip,
    willCast: willCast, monsterCast: monsterCast, castable: castable, elementName: elementName,
    BREATH_CAP: BREATH_CAP,
    EFFECTS: EFFECTS, METHOD_VERB: METHOD_VERB
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Combat;
