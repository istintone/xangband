/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* signature.js — サイト固有の機構。docs/08 §8.5-8.6, docs/10 §10.2。DOM 非依存。
 *
 * 「同じ深度・同じ装備でも、サイトが変われば次の一手が変わるか」が
 * 差別化の判定基準 (docs/10 §10.1)。ここがその答えを作る。
 *
 *   方舟 pressure     … 区画ごとの気圧。扉を開けると均される ([[D-47]])
 *   灰   daynight     … 昼夜で環境光・温度・放射線・敵が変わる
 *   尖塔 surveillance … 監視に補足されると増援が湧き続ける
 *   遺跡 dark         … 環境光0。env だけで成立するのでここでは何もしない
 */
'use strict';

var Signature = (function () {

  /* ---------- 入階時の仕込み ---------- */

  function onEnter(W) {
    var sig = W.site && W.site.signature;
    if (sig === 'pressure') initPressure(W);
    else if (sig === 'daynight') applyDayNight(W, true);
    else if (sig === 'surveillance') initSurveillance(W);
  }

  /* ================= 方舟: 区画ごとの気圧 ([[D-47]]) ================= */

  /**
   * 部屋ごとに気圧を割り振る。通路は低圧。
   * 敵は扉を開けないので、**気圧を操作できるのはプレイヤーだけ**。
   * この非対称性が「扉を開けるか」という選択を生む (docs/10 §10.2)。
   */
  /* 破断の割合は深度で変わる。浅い層はまだ与圧が生きていて、
     深部ほど船が壊れている。物語としても自然で、難易度曲線も素直になる。
     深度1 の時点で通路が真空だと、初期装備(気密1)では一歩も動けない ([[D-61]])。 */
  /** サイト内の進行度 0(最浅) 〜 1(最深)。 */
  function siteT(site, depth) {
    var span = Math.max(1, site.depthMax - site.depthMin);
    return U.clamp((depth - site.depthMin) / span, 0, 1);
  }

  function breachRate(site, depth) {
    return 0.10 + siteT(site, depth) * 0.75;         // 10% → 85%
  }

  /**
   * 破断した区画の気圧。**破断の割合だけでなく深さも深度で変える**。
   * 浅い層の破断を即座に真空(必要気密4)にすると、気密4の装甲スーツが
   * 買える深度10 まで一歩も入れない区画が生まれる。
   * 45 → 10 と落とすことで、必要気密が 1 → 4 と段階的に上がり、
   * 作業スーツ(深度1) → 真空作業服(深度4) → 装甲スーツ(深度10)
   * という装備の階段と噛み合う ([[D-62]])。
   */
  function breachAir(site, depth) {
    return Math.round(45 - siteT(site, depth) * 35);  // 45 → 10
  }

  function initPressure(W) {
    var lv = W.level;
    var rng = W.rng.derive('pressure/' + W.depth);
    lv.pressure = new Uint8Array(lv.w * lv.h);

    var rate = breachRate(W.site, W.depth);
    var SEALED = 75;                                 // 与圧されている = 呼吸できる
    var BREACH = breachAir(W.site, W.depth);

    /* 通路は深度が浅いうちは与圧されている。
       深部では通路から破断していく(区画だけが島のように残る)。 */
    var hallSealed = rng.float() > rate;
    for (var i = 0; i < lv.pressure.length; i++) {
      lv.pressure[i] = hallSealed ? SEALED : BREACH;
    }

    // 部屋ごとに破断しているかを決める
    for (var r = 0; r < lv.rooms.length; r++) {
      var room = lv.rooms[r];
      var p = rng.float() < rate ? BREACH : SEALED;
      for (var y = room.y1; y <= room.y2; y++) {
        for (var x = room.x1; x <= room.x2; x++) {
          if (!World.inBounds(lv, x, y)) continue;
          lv.pressure[y * lv.w + x] = p;
        }
      }
    }

    // 入った場所と階段は必ず生存可能にする(入った瞬間に死なせない)
    floodPressure(lv, W.player.x, W.player.y, SEALED);
  }

  /** その座標の気圧。区画気圧が無いサイトではサイトの既定値。 */
  function pressureAt(W, x, y) {
    var lv = W.level;
    if (!lv.pressure) return Env.envOf(W).atmosphere;
    if (!World.inBounds(lv, x, y)) return 0;
    return lv.pressure[y * lv.w + x];
  }

  /** 連結する区画を同じ気圧で塗る(扉は越えない)。 */
  function floodPressure(lv, sx, sy, value) {
    if (!lv.pressure || !World.walkable(lv, sx, sy)) return 0;
    var seen = new Uint8Array(lv.w * lv.h);
    var stack = [sy * lv.w + sx];
    seen[sy * lv.w + sx] = 1;
    var n = 0;
    while (stack.length) {
      var cur = stack.pop();
      var cx = cur % lv.w, cy = (cur - cx) / lv.w;
      lv.pressure[cur] = value;
      n++;
      if (World.getTile(lv, cx, cy) === World.TILE.DOOR) continue;  // 扉で止まる
      for (var d = 0; d < U.ORTHO.length; d++) {
        var nx = cx + U.ORTHO[d].dx, ny = cy + U.ORTHO[d].dy;
        if (!World.walkable(lv, nx, ny)) continue;
        var ni = ny * lv.w + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    return n;
  }

  /**
   * 扉を通ったときに気圧を均す。
   * 高圧側から低圧側へ抜けると突風が起き、アクターが押し流される。
   * @returns {object|null} { from, to, gust } 起きたことの記録
   */
  function equalize(W, doorX, doorY, fromX, fromY, toX, toY) {
    var lv = W.level;
    if (!lv.pressure) return null;

    var a = pressureAt(W, fromX, fromY);
    var b = pressureAt(W, toX, toY);
    if (Math.abs(a - b) < 10) return null;          // 差が小さければ何も起きない

    // 均した値。体積を考えず単純な平均にする(挙動が読めることを優先)
    var mid = Math.round((a + b) / 2);
    World.setTile(lv, doorX, doorY, World.TILE.FLOOR);   // 扉は開いたまま
    floodPressure(lv, fromX, fromY, mid);
    floodPressure(lv, toX, toY, mid);

    var diff = Math.abs(a - b);
    var gust = diff >= 40;
    if (gust) {
      World.msg(W, '隔壁が開き、空気が一気に流れ込んだ。');
      blowActors(W, toX, toY, a > b ? 1 : -1, fromX, fromY);
    } else {
      World.msg(W, '気圧が均された。');
    }
    return { from: a, to: b, gust: gust };
  }

  /** 突風。扉の周囲のアクターを風下へ1マス押し流す。 */
  function blowActors(W, cx, cy, dir, fromX, fromY) {
    var dx = U.clamp(cx - fromX, -1, 1) * dir;
    var dy = U.clamp(cy - fromY, -1, 1) * dir;
    if (!dx && !dy) return;

    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead) continue;
      if (U.distCheb(a.x, a.y, cx, cy) > 2) continue;
      var nx = a.x + dx, ny = a.y + dy;
      if (!World.walkable(W.level, nx, ny)) continue;
      if (World.actorAt(W, nx, ny)) continue;
      a.x = nx; a.y = ny;
      if (a.kind === 'monster') a.asleep = 0;        // 起きる
      if (a.kind === 'player') World.msg(W, '突風に押し流された。');
    }
  }

  /* ================= 灰の地表: 昼夜 ================= */

  var DAY_LENGTH = 1000;      // ゲームターン。半分が昼、半分が夜

  function isNight(W) {
    return Math.floor(W.turn / (DAY_LENGTH / 2)) % 2 === 1;
  }

  /** 昼夜を環境に反映する。@param force 入階時は必ず適用 */
  function applyDayNight(W, force) {
    var night = isNight(W);
    if (!force && W.level.night === night) return false;

    var base = W.site.env;
    W.level.night = night;
    W.level.env.ambient = night ? 0 : base.ambient;
    W.level.env.temperature = base.temperature + (night ? -50 : 30);
    W.level.env.radiation = night ? Math.max(0, base.radiation - 4) : base.radiation + 3;

    if (!force) {
      World.msg(W, night ? '陽が落ちた。灰が冷えていく。'
                         : '夜が明けた。恒星風が地表を舐めはじめる。');
    }
    return true;
  }

  /* ================= 尖塔: 監視と増援 ================= */

  function initSurveillance(W) {
    W.alerted = false;
    W.alertLevel = 0;
    W.reinforceAt = 0;
  }

  /**
   * 監視に補足されるか。隠密が高いほど見つかりにくい。
   * 補足されると**増援が湧き続ける**ので、戦って解決できない。
   */
  function checkSurveillance(W) {
    var env = Env.envOf(W);
    if (env.surveillance <= 0) return;
    if (Site.hasAdaptation(W, 'watch')) return;      // 《適合:監視》で無効化
    if (Net.isBlinded(W)) return;                    // 走査系を止めている (docs/11 §11.3)

    var p = W.player;
    if (!W.alerted) {
      // 隠密が高いほど見つかりにくい。明かりを消していれば更に。
      var stealth = (p.skills && p.skills.stealth) || 0;
      var risk = env.surveillance * 2 - stealth;
      if (p.lightOff) risk -= 6;
      if (risk > 0 && W.rng.int(1000) < risk) {
        W.alerted = true;
        W.alertLevel = 1;
        W.reinforceAt = W.turn + 60;
        World.msg(W, '監視網に補足された。増援が来る。');
      }
      return;
    }

    // 補足中は定期的に増援。時間が経つほど濃くなる。
    if (W.turn >= W.reinforceAt) {
      spawnReinforcement(W);
      W.alertLevel++;
      W.reinforceAt = W.turn + Math.max(40, 120 - W.alertLevel * 10);
    }
  }

  function spawnReinforcement(W) {
    var rng = W.rng.derive('reinforce/' + W.turn);
    var n = Math.min(3, 1 + Math.floor(W.alertLevel / 3));
    var made = 0;
    for (var i = 0; i < n; i++) {
      var race = Monster.pickNormal(rng, W, W.depth, W.site);
      if (!race) continue;
      var spot = Monster.findSpawnSpot(rng, W, 8);
      if (!spot) continue;
      var mon = Monster.spawn(rng, race, spot.x, spot.y);
      mon.asleep = 0;                                // 呼ばれて来たので起きている
      World.addActor(W, mon);
      made++;
    }
    if (made) World.msg(W, '増援が到着した。');
  }

  /** 補足を解除する手段。監視装置を壊すか、階を移る。 */
  function clearAlert(W) {
    if (!W.alerted) return false;
    W.alerted = false;
    W.alertLevel = 0;
    World.msg(W, '監視網から外れた。');
    return true;
  }

  /* ---------- 毎ゲームターン ---------- */

  function tick(W) {
    var sig = W.site && W.site.signature;
    if (sig === 'daynight') applyDayNight(W, false);
    else if (sig === 'surveillance') checkSurveillance(W);

    // 方舟: 立っている区画の気圧を環境に反映する
    if (sig === 'pressure' && W.level.pressure) {
      W.level.env.atmosphere = pressureAt(W, W.player.x, W.player.y);
    }
  }

  return {
    onEnter: onEnter, tick: tick,
    initPressure: initPressure, pressureAt: pressureAt,
    breachRate: breachRate, breachAir: breachAir, siteT: siteT,
    floodPressure: floodPressure, equalize: equalize, blowActors: blowActors,
    DAY_LENGTH: DAY_LENGTH, isNight: isNight, applyDayNight: applyDayNight,
    initSurveillance: initSurveillance, checkSurveillance: checkSurveillance,
    spawnReinforcement: spawnReinforcement, clearAlert: clearAlert
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Signature;
