/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* monster.js — 敵の生成と配置。DOM 非依存。 */
'use strict';

var Monster = (function () {

  /** 定義から実体を作る。定義(race)は共有し、個体の状態だけを持つ。 */
  function spawn(rng, race, x, y) {
    var base = Data.get().monsterBase[race.base];
    var hp = Data.rollDice(rng, race.hp);
    var m = Actor.create({
      kind: 'monster',
      raceId: race.id,
      name: race.name,
      glyph: race.glyph || base.glyph,
      color: race.color || base.color,
      base: race.base,
      level: race.level,
      mexp: race.mexp,
      blows: race.blows || [],
      spells: race.spells || null,            // 遠隔攻撃 ([[D-68]])
      flags: race.flags || [],
      speed: race.speed,
      ac: race.ac,
      hp: hp, hpMax: hp,
      x: x, y: y,
      // AI 状態。ai.js が使う。
      target: null,        // 最後に見たプレイヤーの位置
      fleeing: false,
      // 眠った状態で配置する ([[D-40]])。これが無いと全員が初手から殺到する。
      asleep: rng.range(race.sleep || 25, (race.sleep || 25) * 2)
    });
    // 生成直後に全員が同時に動き出さないよう、初期エネルギーをばらす
    m.energy = rng.int(Turn.ACTION_COST);
    return m;
  }

  /**
   * 1階に居られるアクターの上限 ([[D-90]])。
   * 通常の階の人口は実測で 18〜61 体なので、その上限に合わせた ――
   * 「召喚で普通の階より混む」ことは無い、という基準。
   */
  var MAX_ACTORS = 60;

  /** その階はもう満員か。 */
  function atCapacity(W) {
    var n = 0;
    for (var i = 0; i < W.actors.length; i++) if (!W.actors[i].dead) n++;
    return n >= MAX_ACTORS;
  }

  /**
   * 敵の近くに増援を呼ぶ ([[D-68]] の summon)。
   * 呼ばれた敵は**起きている**。呼ぶ意味が無くなるため。
   *
   * 呼ばれた敵には `summoned` を立てる ([[D-90]])。
   * これが無いと連鎖する ―― 召喚する敵は全体の22%あり、
   * うち3体は呪文が召喚しかないので、呼んだ相手がまた呼ぶ。
   * @returns {number} 実際に湧いた数
   */
  function summonNear(W, mon, count, depth) {
    var rng = W.rng.derive('summon/' + mon.id + '/' + W.turn);
    var made = 0;
    for (var i = 0; i < count; i++) {
      if (atCapacity(W)) break;
      var race = pickNormal(rng, W, depth, W.site);
      if (!race) continue;
      var spot = nearbyFreeSpot(rng, W, mon.x, mon.y, 4);
      if (!spot) continue;
      var sum = spawn(rng, race, spot.x, spot.y);
      sum.asleep = 0;
      sum.summoned = true;
      World.addActor(W, sum);
      made++;
    }
    return made;
  }

  function hasFlag(m, f) { return m.flags.indexOf(f) !== -1; }

  /** 歩けて、他のアクターが居らず、プレイヤーから離れた床を探す。 */
  function findSpawnSpot(rng, W, minDistFromPlayer) {
    var lv = W.level;
    for (var tries = 0; tries < 200; tries++) {
      var room = rng.pick(lv.rooms);
      if (!room) return null;
      var x = rng.range(room.x1, room.x2);
      var y = rng.range(room.y1, room.y2);
      if (!World.walkable(lv, x, y)) continue;
      if (World.actorAt(W, x, y)) continue;
      if (U.distCheb(x, y, W.player.x, W.player.y) < minDistFromPlayer) continue;
      return { x: x, y: y };
    }
    return null;
  }

  /**
   * 抽選対象からユニークを除く。
   * ユニークは1ランに1体で、専用の経路(placeUniques)からしか出さない。
   */
  function pickNormal(rng, W, depth, site) {
    for (var t = 0; t < 20; t++) {
      var race = site ? Site.pickMonster(rng, site, depth) : Data.pickMonster(rng, depth);
      if (!race) return null;
      if ((race.flags || []).indexOf('UNIQUE') === -1) return race;
    }
    return null;
  }

  /** 群れ/護衛を伴わせる (本家の escort)。 */
  function addRetinue(rng, W, race, x, y, depth) {
    var flags = race.flags || [];
    var n = 0;

    if (flags.indexOf('GROUP') !== -1) {
      var extra = rng.range(1, 3);
      for (var g = 0; g < extra; g++) {
        var near = nearbyFreeSpot(rng, W, x, y, 3);
        if (near) { World.addActor(W, spawn(rng, race, near.x, near.y)); n++; }
      }
    }

    // ESCORT は別種の護衛を連れる。ユニークの威圧感はここから来る。
    if (flags.indexOf('ESCORT') !== -1 && race.escort) {
      var guard = Data.get().monstersById[race.escort];
      if (guard) {
        var num = Data.rollDice(rng, race.escortNum || '1d3');
        for (var e = 0; e < num; e++) {
          var spot = nearbyFreeSpot(rng, W, x, y, 4);
          if (spot) { World.addActor(W, spawn(rng, guard, spot.x, spot.y)); n++; }
        }
      }
    }
    return n;
  }

  /**
   * ユニークを配置する。**1ランに1体**。倒すと二度と出ない (docs/02 §2.9)。
   * 深度の節目にだけ現れる。
   */
  /**
   * そのサイトの守護ユニーク。最深階に**確定で**出る ([[D-69]])。
   * 《適合》は進行に必須なので、抽選に任せると
   * 「最深階に何度潜っても出ない」ランが生まれる。
   */
  function guardianFor(site) {
    if (!site) return null;
    var db = Data.get();
    for (var i = 0; i < db.monsters.length; i++) {
      var m = db.monsters[i];
      if (m.guardian && m.site === site.id) return m;
    }
    return null;
  }

  function placeUniques(rng, W, depth, site) {
    var db = Data.get();
    var placed = 0;

    // --- 守護ユニーク: サイトの最深階に確定配置 ---
    if (site && depth >= site.depthMax) {
      var guard = guardianFor(site);
      if (guard && !W.uniquesKilled[guard.id] && placeUnique(rng, W, guard, depth)) {
        placed++;
      }
    }

    // --- 通常のユニーク: 抽選。**自分のサイト以外には出ない** ---
    var candidates = db.monsters.filter(function (m) {
      return (m.flags || []).indexOf('UNIQUE') !== -1 &&
             !m.guardian &&                                 // 守護は上で扱った
             !W.uniquesKilled[m.id] &&
             (!m.site || (site && m.site === site.id)) &&
             m.depth <= depth && m.depth + 8 >= depth;   // 深すぎる階には出さない
    });
    if (candidates.length === 0) return placed;
    if (!rng.oneIn(4)) return placed;                     // 毎階は出さない

    if (placeUnique(rng, W, rng.pick(candidates), depth)) placed++;
    return placed;
  }

  function placeUnique(rng, W, race, depth) {
    var spot = findSpawnSpot(rng, W, 20);
    if (!spot) return false;
    var mon = spawn(rng, race, spot.x, spot.y);
    mon.unique = true;
    mon.guardian = !!race.guardian;
    World.addActor(W, mon);
    addRetinue(rng, W, race, spot.x, spot.y, depth);
    return true;
  }

  /**
   * 階層に敵を配置する。深度が深いほど数が増える。
   */
  function populate(rng, W, depth, site) {
    // 本家の深度1が 8〜14 体程度。群れで増えるぶんを見込んで基礎は控えめにする。
    var count = 5 + rng.range(0, 3) + Math.floor(depth / 3);
    for (var i = 0; i < count; i++) {
      var race = pickNormal(rng, W, depth, site);
      if (!race) continue;
      var spot = findSpawnSpot(rng, W, 12);
      if (!spot) continue;

      World.addActor(W, spawn(rng, race, spot.x, spot.y));
      addRetinue(rng, W, race, spot.x, spot.y, depth);
    }
    placeUniques(rng, W, depth, site);
  }

  /** 指定座標に敵を1体置く (区画テンプレート/Vault の 9 と 8 用)。 */
  function placeAt(rng, W, x, y, depth) {
    var race = pickNormal(rng, W, depth);
    if (!race) return null;
    if (World.actorAt(W, x, y)) return null;
    var mon = spawn(rng, race, x, y);
    World.addActor(W, mon);
    return mon;
  }

  function nearbyFreeSpot(rng, W, cx, cy, radius) {
    for (var t = 0; t < 30; t++) {
      var x = cx + rng.range(-radius, radius);
      var y = cy + rng.range(-radius, radius);
      if (!World.walkable(W.level, x, y)) continue;
      if (World.actorAt(W, x, y)) continue;
      return { x: x, y: y };
    }
    return null;
  }

  return {
    spawn: spawn, populate: populate, hasFlag: hasFlag,
    pickNormal: pickNormal, addRetinue: addRetinue, placeUniques: placeUniques,
    placeAt: placeAt,
    findSpawnSpot: findSpawnSpot, nearbyFreeSpot: nearbyFreeSpot,
    summonNear: summonNear, guardianFor: guardianFor, placeUnique: placeUnique,
    MAX_ACTORS: MAX_ACTORS, atCapacity: atCapacity
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Monster;
