/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* player.js — プレイヤー。系統・ロール・能力値・経験値・成長。DOM 非依存。
 *
 * M2 で lineages.json / roles.json から作る ([[D-37]])。
 * 能力値は 18/xx 対応 (stat.js, [[D-34]])。
 */
'use strict';

var Player = (function () {

  /* 本家 player_exp[] に対応する必要経験値表 (レベル1->2 が 10)。
     実際の必要量は expFactor(百分率) を掛ける (docs/02 §2.5)。 */
  var EXP_TABLE = [
    10, 25, 45, 70, 100, 140, 200, 280, 380, 500,
    650, 850, 1100, 1400, 1800, 2300, 2900, 3600, 4400, 5400,
    6800, 8400, 10200, 12500, 17500, 25000, 35000, 50000, 75000, 100000,
    150000, 200000, 275000, 350000, 450000, 550000, 700000, 850000, 1000000, 1250000,
    1500000, 1800000, 2100000, 2400000, 2700000, 3000000, 3500000, 4000000, 4500000, 5000000
  ];
  var MAX_LEVEL = 50;

  /* ロールの優先順位に沿って配る基本値。本家のポイント割り振りに相当する。
     完全ランダムだと「主能力値が 8 のキャラ」ができてしまい、
     そのランは何をしても成立しない。ロールの個性を保証するために固定する ([[D-41]])。 */
  var STAT_SPREAD = [17, 16, 15, 12, 11, 10];

  /**
   * 能力値を決める。ロールの statOrder に沿って STAT_SPREAD を配り、
   * 系統の補正を足す。乱数は「わずかな揺らぎ」にだけ使う。
   */
  function rollStats(rng, lineage, role) {
    var keys = ['str', 'int', 'wis', 'dex', 'con', 'chr'];
    var stats = {};

    if ((lineage.flags || []).indexOf('RANDOM_STATS') !== -1) {
      // 未登録個体だけは一様分布。当たり外れが大きいのがこの系統の identity。
      for (var r = 0; r < keys.length; r++) {
        stats[keys[r]] = Stat.clamp(rng.range(8, 18) + (lineage.stats[keys[r]] || 0));
      }
      return stats;
    }

    var order = role.statOrder || keys;
    for (var i = 0; i < keys.length; i++) stats[keys[i]] = 10;
    for (var j = 0; j < order.length; j++) {
      var base = STAT_SPREAD[j] !== undefined ? STAT_SPREAD[j] : 10;
      // ±1 の揺らぎ。同じ組み合わせでもランごとに少し違う。
      stats[order[j]] = Stat.clamp(base + rng.range(-1, 1) + (lineage.stats[order[j]] || 0));
    }
    return stats;
  }

  function expNeeded(level, expFactor) {
    if (level >= MAX_LEVEL) return Infinity;
    return Math.floor(EXP_TABLE[level - 1] * expFactor / 100);
  }

  /**
   * レベル L 時点の HP を決める。
   * レベルごとのロールを固定シードで引くので、同一シード・同一レベルなら必ず同じ HP になる
   * (docs/02 §2.5)。レベルアップのたびに乱数の流れを消費しない。
   */
  function hpForLevel(seed, level, hitDie, con) {
    var r = RNG.create(seed + '/hp');
    var total = hitDie;                        // レベル1は最大値
    for (var l = 2; l <= level; l++) total += 1 + r.int(hitDie);
    return Math.max(1, total + Stat.hpBonus(con) * level);
  }

  /**
   * キャラクターを作る。
   * @param seed      ランのシード
   * @param lineageId 系統 id (省略時は terran)
   * @param roleId    ロール id (省略時は marine)
   */
  function create(seed, lineageId, roleId) {
    var db = Data.get();
    var lin = db.lineagesById[lineageId || 'terran'];
    var role = db.rolesById[roleId || 'marine'];
    if (!lin) throw new Error('未知の系統: ' + lineageId);
    if (!role) throw new Error('未知のロール: ' + roleId);

    var rng = RNG.create(seed + '/char/' + lin.id + '/' + role.id);
    var stats = rollStats(rng, lin, role);

    // 技能は「系統 + ロール」の合算 (本家準拠)
    var skills = {};
    for (var k in role.skills) skills[k] = role.skills[k] + (lin.skills[k] || 0);

    var p = Actor.create({
      kind: 'player',
      lineage: lin.id, lineageName: lin.name,
      role: role.id, roleName: role.name,
      stats: stats,
      statBonus: { str: 0, int: 0, wis: 0, dex: 0, con: 0, chr: 0 },
      statDrain: { str: 0, int: 0, wis: 0, dex: 0, con: 0, chr: 0 },
      baseSkills: skills,
      skills: { melee: 0, shoot: 0, stealth: 0, perception: 0, disarm: 0 },
      skillsPerLevel: role.skillsPerLevel,
      // ヒットダイスは本家と同じく「系統 + ロール」の合算 ([[D-33]])
      hitDie: lin.hitDie + role.hitDie,
      expFactor: Math.round(lin.expFactor * role.expFactor / 100),
      maxBlows: role.maxBlows,
      system: role.system, spStat: role.spStat,
      abilityPool: (role.abilities || []).slice(),
      abilities: [],
      sp: 0, spMax: 0,
      cog: 0, cogMax: 0,                 // 認知。電脳層の資源 (docs/11 §11.2)
      cogBonus: role.cogBonus || 0,
      lineageFlags: (lin.flags || []).slice(),
      infra: lin.infra || 0,
      level: 1, exp: 0,
      lightRadius: 1,
      cells: 400,
      food: 5000,
      exposure: 0,
      depthMax: 0,
      seedRef: seed
    });

    p.hpMax = hpForLevel(seed, 1, p.hitDie, Stat.effective(p, 'con'));
    p.hp = p.hpMax;
    recalcSkills(p);
    p.spMax = Ability.maxSP(p);
    p.sp = p.spMax;
    p.cogMax = maxCog(p);
    p.cog = p.cogMax;
    return p;
  }

  /**
   * 認知の上限 (docs/11 §11.2)。
   * **HP とは別の軸**にするために、戦闘では減らず休息以外では戻らない。
   */
  function maxCog(p) {
    // 演算(INT)の影響は SP と同じ spMult を使う。新しい表を増やさない
    var mult = Stat.spMult(Stat.effective(p, 'int'));   // 1/10 単位
    return Math.max(1, 5 + Math.floor(p.level / 2) + Math.floor(mult / 4) + (p.cogBonus || 0));
  }

  /** 技能はレベルで伸びる (1/10 単位で持つ本家の形)。 */
  function recalcSkills(p) {
    for (var k in p.baseSkills) {
      var per = (p.skillsPerLevel && p.skillsPerLevel[k]) || 0;
      p.skills[k] = p.baseSkills[k] + Math.floor(per * (p.level - 1) / 10);
    }
  }

  /**
   * 経験値を与える。必要ならレベルアップする。
   * @returns {number} 上がったレベル数
   */
  function gainExp(p, amount) {
    p.exp += Math.max(0, Math.floor(amount));
    var gained = 0;
    while (p.level < MAX_LEVEL && p.exp >= expNeeded(p.level, p.expFactor)) {
      p.level++;
      gained++;
      var before = p.hpMax;
      p.hpMax = hpForLevel(p.seedRef, p.level, p.hitDie, Stat.effective(p, 'con'));
      p.hp += (p.hpMax - before);            // 増えたぶんは即座に回復する
      recalcSkills(p);
    }
    return gained;
  }

  /** 敵を倒したときの獲得経験値 (本家式: mexp * level / plev)。 */
  function expFromKill(mon, playerLevel) {
    return Math.floor((mon.mexp || 0) * (mon.level || 1) / Math.max(1, playerLevel));
  }

  function hasFlag(p, f) { return p.lineageFlags.indexOf(f) !== -1; }

  /** ゲームターンごとの維持処理: 満腹度・自然回復・SP。 */
  function upkeep(W, p) {
    if (p.dead) return;

    // 満腹度。合成体は食事が要らない代わりにセルで駆動する。
    if (!hasFlag(p, 'NO_FOOD')) {
      var rate = 1 + ((p.equipBonus && p.equipBonus.hunger > 0) ? 1 : 0) +
                 (p.mutationHunger ? 1 : 0);
      p.food -= rate;
      if (p.food <= 0) {
        p.food = 0;
        if (W.turn % 10 === 0) {
          W.lastAttacker = '飢餓';
          Actor.damage(p, 1);
          World.msg(W, '衰弱している。');
        }
      }
    } else if (hasFlag(p, 'CELL_DRIVEN')) {
      if (W.turn % 25 === 0) p.cells = Math.max(0, p.cells - 1);
      if (p.cells === 0 && W.turn % 10 === 0) {
        W.lastAttacker = '電力切れ';
        Actor.damage(p, 1);
        World.msg(W, '電力が尽きかけている。');
      }
    }

    // 自然回復。刻印「再生」があれば速い。
    var regen = 10 - Math.min(4, (p.equipBonus && p.equipBonus.regen) || 0) * 2;
    if (p.hp < p.hpMax && W.turn % Math.max(2, regen) === 0) {
      Actor.heal(p, 1 + Math.floor(p.level / 8));
    }

    // 毒は回復を上書きする
    if (p.timers.poison > 0 && W.turn % 10 === 0) {
      W.lastAttacker = '汚染';
      Actor.damage(p, 1);
    }

    // 汚染ファーム「電力漏出」
    if (p.equipBonus && p.equipBonus.drain > 0 && W.turn % 20 === 0) {
      p.cells = Math.max(0, p.cells - 1);
    }

    /* 認知の回復。**時間経過のみ**。戦闘でもアイテムでも戻らない。
       「まだ一回ぶん残っているか」を戦闘とは独立に数えさせる (docs/11 §11.2)。 */
    if (p.cog < p.cogMax && W.turn % 40 === 0) p.cog++;

    Ability.upkeep(W, p);
  }

  return {
    EXP_TABLE: EXP_TABLE, MAX_LEVEL: MAX_LEVEL, STAT_SPREAD: STAT_SPREAD,
    rollStats: rollStats, hpForLevel: hpForLevel, expNeeded: expNeeded,
    create: create, recalcSkills: recalcSkills,
    gainExp: gainExp, expFromKill: expFromKill, hasFlag: hasFlag, upkeep: upkeep,
    maxCog: maxCog
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Player;
