/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* cmd.js — コマンド解決とゲーム進行。DOM 非依存 ([[D-28]])。
 *
 * ここがヘッドレスでも動くので、受け入れ基準の自動プレイを測れる。
 *
 * 不変条件4 (docs/01 §1.5): エネルギーを消費しない行動を作らない。
 * メタ操作(インベントリ閲覧など)は明確に分ける。
 */
'use strict';

var Cmd = (function () {

  /* ---------- 階層の出入り ---------- */

  /**
   * 深度 depth へ移動する。depth 0 は母船《アンカー》([[D-39]])。
   */
  function enterLevel(W, depth, fromBelow) {
    // プレイヤー以外を捨てる (階層は非永続 — docs/02 §2.3)
    W.actors = W.actors.filter(function (a) { return a.kind === 'player'; });
    W.items = [];
    W.depth = depth;

    if (depth === 0) {
      W.level = Hub.createLevel();
      W.level.env = Env.create(null);          // 母船は標準環境
      Signature.initSurveillance(W);           // 補足は階を移ると切れる
      Target.clear(W);
      W.player.x = W.level.down.x;
      W.player.y = W.level.down.y - 1;
      Hub.restock(W, !W.shops);
      W.feeling = { danger: 0, loot: 0, lootKnown: true };
      W.player.cog = W.player.cogMax;            // 母船では認知が全快する
      World.msg(W, '母船《アンカー》。');
      if (W.returning && !W.won) win(W);          // 帰還して初めて勝利 (§7.5)
      refreshView(W);
      return;
    }

    // サイトが未設定なら最初のサイトに入る(セーブ互換のため)
    if (!W.site) W.site = Site.starting()[0] || Site.all()[0];

    var lrng = W.rng.derive(W.site.id + '/L' + depth + '#' + W.turn);
    var env = Env.create(W.site.env);
    var lv, fixedMarks = null;

    /* 《起源》だけは部分的に固定する (docs/02 §2.3 の例外 / docs/07 §7.4)。
       98 で静かにさせることが 99・100 の重さを作る。 */
    var fixed = W.site.id === 'origin' ? Origin.fixedFor(depth) : null;
    if (fixed) {
      var built = Origin.buildFixed(lrng, fixed, env, W);
      lv = built.level;
      fixedMarks = built.marks;
    } else {
      var plan = W.site.id === 'origin' ? Origin.genFor(lrng, depth) : null;
      lv = Gen.generate(lrng, depth, plan ? plan.opts : Site.genOpts(W.site));
      lv.env = env;
      // 接続層は階ごとに別のサイトの顔をしている。地形で「同じものだった」ことを示す
      if (plan && plan.lookSite) lv.lookSite = plan.lookSite.id;
    }
    lv.site = W.site.id;
    W.level = lv;
    /* 補足は階を移ると切れる。alerted だけ消して alertLevel を残すと、
       次の階で即座に最大警戒から始まり、尖塔から二度と抜けられない。 */
    Signature.initSurveillance(W);
    Target.clear(W);

    /* 固定階には片方の階段しか無いことがある(《門番》の降下シャフトは
       倒すまで開かない)。無い側から入ろうとしても落ちないようにする。 */
    var start = (fromBelow ? lv.down : lv.up) || lv.up || lv.down;
    if (!start) throw new Error('階に階段が無い: 深度 ' + depth);
    W.player.x = start.x;
    W.player.y = start.y;

    if (fixedMarks) {
      populateFixed(lrng, W, lv, fixedMarks);      // 固定階は中身も固定
    } else {
      Monster.populate(lrng, W, depth, W.site);
      Item.populate(lrng, W, depth);
      populateMarks(lrng, W, lv, depth);
    }

    if (depth > W.player.depthMax) W.player.depthMax = depth;
    Site.noteDepth(W, W.site.id, depth);
    Signature.onEnter(W);                        // サイト固有の機構を仕込む
    computeFeeling(W);
    refreshView(W);

    var envText = Env.describe(W);
    World.msg(W, W.site.name + ' 深度 ' + depth + '。' + feelingText(W) +
                 (envText ? ' ' + envText : ''));
    if (depth === W.site.depthMin && W.site.enterText) World.msg(W, W.site.enterText);

    // 《起源》は層ごとに一言を変える。深さの質が変わったことを告げる
    if (W.site.id === 'origin') {
      var ot = Origin.enterText(depth);
      if (ot) World.msg(W, ot);
    }
  }

  /**
   * 《起源》の固定階の中身を置く。
   * 通常の配置(敵・アイテム・区画テンプレート)は**一切走らせない**。
   * 静止層に敵が湧いたら、静止層である意味が無くなる。
   */
  function populateFixed(rng, W, lv, marks) {
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      if (m.kind === 'lore') {
        Fragment.place(rng, W, m.x, m.y, lv.depth);
      } else if (m.kind === 'warden' || m.kind === 'origin') {
        var id = m.kind === 'warden' ? 'u-warden' : 'u-origin';
        var race = Data.get().monstersById[id];
        if (!race) continue;
        var boss = Monster.spawn(rng, race, m.x, m.y);
        boss.unique = true;
        boss.asleep = 0;                        // 待っている。眠ってはいない
        World.addActor(W, boss);
        if (m.kind === 'warden') W.wardenAt = { x: m.x, y: m.y };
      }
    }
  }

  /**
   * 区画テンプレート / Vault の中身を配置する (docs/02 §2.4)。
   * 生成器は「どこに置くか」だけを記録しているので、ここで実体を作る。
   */
  function populateMarks(rng, W, lv, depth) {
    var marks = lv.marks || [];
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      // Vault の中身は深度+10(小) / +20(大) で抽選する。明確に格上が出る。
      var boost = m.vault ? (m.size === 'great' ? 20 : 10) : 0;
      var d = depth + boost;

      if (m.kind === 'item') Item.placeAt(rng, W, m.x, m.y, depth);
      else if (m.kind === 'goodItem') Item.placeAt(rng, W, m.x, m.y, d);
      else if (m.kind === 'monster') Monster.placeAt(rng, W, m.x, m.y, depth);
      else if (m.kind === 'toughMonster') Monster.placeAt(rng, W, m.x, m.y, d);
    }
  }

  /* ---------- 階の予感 (docs/02 §2.3) ---------- */

  function computeFeeling(W) {
    var danger = 0, i;
    for (i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.kind === 'player') continue;
      var race = Data.get().monstersById[a.raceId];
      if (!race) continue;
      danger += Math.max(0, race.depth - W.depth) + 1;
      if (a.unique) danger += 12;
    }

    var loot = 0;
    for (i = 0; i < W.items.length; i++) {
      var it = W.items[i];
      if (it.uniqueId) loot += 40;
      else if (it.egoId) loot += 8;
      loot += Math.min(10, Math.round((it.cost || 0) / 200));
    }

    /* 予感は敵の**数**を数える式なので、単体の格上を過小評価する。
       深度100 に《起源》が1体だけ居る階が「危険2」と出ていた。
       ユニークが居る階には下限を敷いて、量ではなく質を伝える。 */
    var floor = 0;
    for (i = 0; i < W.actors.length; i++) {
      var f = W.actors[i];
      if (!f.unique || f.dead) continue;
      floor = Math.max(floor, Monster.hasFlag(f, 'FINAL') ? 9 : 7);
    }

    W.feeling = {
      danger: Math.max(floor, scale(danger, [0, 8, 16, 26, 38, 52, 70, 95, 130])),
      loot: scale(loot, [0, 6, 14, 24, 36, 52, 72, 100, 140]),
      lootKnown: false                     // 有望度は歩いて初めて開示する(本家準拠)
    };
  }

  function scale(v, thresholds) {
    for (var i = thresholds.length - 1; i >= 0; i--) {
      if (v >= thresholds[i]) return i + 1;
    }
    return 0;
  }

  var DANGER_TEXT = [
    'ここには何もいない。', '静かだ。', '落ち着いている。', '何かの気配がある。',
    '嫌な感じがする。', '危険だ。', 'ひどく危険だ。', '死の匂いがする。',
    'ここは墓場だ。', '生きて帰れる気がしない。'
  ];
  var LOOT_TEXT = [
    '見るべきものは無さそうだ。', '目ぼしいものは無い。', '多少は拾えそうだ。',
    '何かありそうだ。', '期待できる。', '良いものがある。', '大物の気配がある。',
    '滅多にない収穫だ。', '伝説級の何かがある。', 'ここに全てがある。'
  ];

  function feelingText(W) {
    var s = DANGER_TEXT[U.clamp(W.feeling.danger, 0, 9)];
    if (W.feeling.lootKnown) s += ' ' + LOOT_TEXT[U.clamp(W.feeling.loot, 0, 9)];
    return s;
  }

  function refreshView(W) {
    var p = W.player;
    p.lightRadius = Inventory.lightRadius(p, W.inv);
    FOV.compute(W.level, p.x, p.y, p.lightRadius);
    AI.computeFlow(W);
    // 見えている敵を知識に加える
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.kind === 'player' || a.dead) continue;
      if (World.hasFlag(W.level, a.x, a.y, World.F.VISIBLE)) Lore.noteSeen(W, a);
    }
  }

  /** 装備と状態から派生する値を再計算する。装備変更のたびに呼ぶ。 */
  function recalc(W) {
    var p = W.player;
    var bonus = Inventory.equipBonus(W.inv);
    p.equipBonus = bonus;

    var env = Env.envOf(W);

    p.statBonus = bonus.stats;
    p.ac = Inventory.totalAC(W.inv) + Stat.hitBonus(Stat.effective(p, 'dex')) +
           (p.mutationAC || 0);
    p.seal = Inventory.totalSeal(W.inv) + bonus.seal +
             (Player.hasFlag(p, 'SEAL_INNATE') ? 2 : 0);
    // 重力が速度に効く。低重力は速く、高重力は遅い (docs/08 §8.3)。
    p.speed = Turn.NORMAL_SPEED + Inventory.speedPenalty(p, W.inv, env) + bonus.speed +
              Env.speedMod(env);
    p.lightRadius = Inventory.lightRadius(p, W.inv);
    p.spMax = Ability.maxSP(p);
    if (p.sp > p.spMax) p.sp = p.spMax;
    p.cogMax = Player.maxCog(p);
    if (p.cog > p.cogMax) p.cog = p.cogMax;
    Player.recalcSkills(p);

    // 系統の固有耐性
    if (Player.hasFlag(p, 'NO_POISON')) bonus.resist.pois = true;
    if (Player.hasFlag(p, 'NO_RAD')) bonus.resist.rad = true;
    if (Player.hasFlag(p, 'TAINT_RESIST')) bonus.resist.pois = true;
  }

  /* ---------- プレイヤーの行動 ---------- */

  function move(W, dx, dy) {
    var p = W.player;
    if (dx === 0 && dy === 0) return true;      // その場で待つ

    // 混乱中は方向がランダムになる (docs/02 §2.7)
    if (p.timers.confused > 0 && W.rng.oneIn(2)) {
      var d = W.rng.pick(U.DIRS);
      dx = d.dx; dy = d.dy;
    }

    var nx = p.x + dx, ny = p.y + dy;
    var foe = World.actorAt(W, nx, ny);
    if (foe && foe.kind === 'monster') return attack(W, foe);

    if (!World.walkable(W.level, nx, ny)) {
      World.msg(W, '構造材に阻まれた。');
      return false;                              // 壁への移動はターンを消費しない
    }

    /* 扉を通ると気圧が均される (方舟のみ — [[D-47]])。
       敵は扉を開けないので、**気圧を操作できるのはプレイヤーだけ**。
       「開けるか」がこのサイトの一手を決める (docs/10 §10.2)。 */
    if (World.getTile(W.level, nx, ny) === World.TILE.DOOR && W.level.pressure) {
      Signature.equalize(W, nx, ny, p.x, p.y, nx + dx, ny + dy);
    }

    p.x = nx; p.y = ny;

    // 歩き始めると有望度が開示される (docs/02 §2.3)
    if (!W.feeling.lootKnown && W.depth > 0) {
      W.feeling.lootKnown = true;
      World.msg(W, LOOT_TEXT[U.clamp(W.feeling.loot, 0, 9)]);
    }

    if (World.getTile(W.level, nx, ny) === World.TILE.TRAP) triggerTrap(W);
    describeFloor(W);
    return true;
  }

  /* 設備障害 (docs/03 の読み替え表: Trap -> 設備障害)。 */
  var TRAPS = [
    { name: '破断配管', fx: function (W, p) { Actor.damage(p, W.rng.dice(2, 6)); World.msg(W, '蒸気が噴き出した。'); } },
    { name: '電磁トラップ', fx: function (W, p) {
        var lost = Math.min(p.cells, W.rng.range(20, 60));
        p.cells -= lost; World.msg(W, '電装が焼かれた。電力 -' + lost); } },
    { name: '自動砲座', fx: function (W, p) { Actor.damage(p, W.rng.dice(3, 5)); World.msg(W, '銃座が作動した。'); } },
    { name: '汚染散布', fx: function (W, p) {
        if (!Combat.resisted(p, 'pois')) { Actor.addTimer(p, 'poison', 12); World.msg(W, '汚染物質を浴びた。'); }
        else World.msg(W, '汚染物質を浴びたが、効かない。'); } },
    { name: '落とし穴', fx: function (W, p) {
        World.msg(W, '床が抜けた。');
        Actor.damage(p, W.rng.dice(2, 8));
        if (!W.dead && W.depth > 0) enterLevel(W, W.depth + 1, false); } }
  ];

  function triggerTrap(W) {
    var p = W.player;
    // 解錠技能で回避できる
    if (W.rng.int(100) < Math.min(75, p.skills.disarm / 2)) {
      World.msg(W, '設備障害を回避した。');
      World.setTile(W.level, p.x, p.y, World.TILE.FLOOR);
      return;
    }
    var t = W.rng.pick(TRAPS);
    World.msg(W, t.name + '!');
    W.lastAttacker = t.name;
    t.fx(W, p);
    World.setTile(W.level, p.x, p.y, World.TILE.FLOOR);
  }

  function describeFloor(W) {
    var p = W.player;
    var here = Item.itemsAt(W, p.x, p.y);
    if (here.length === 1) World.msg(W, Sigil.name(W.knowledge, here[0]) + 'が落ちている。');
    else if (here.length > 1) World.msg(W, here.length + '個のものが落ちている。');

    var t = World.getTile(W.level, p.x, p.y);
    if (t === World.TILE.DOWN) World.msg(W, W.depth === 0 ? '降下ポッド。> で降下する。' : '降下シャフト。> で降りる。');
    else if (t === World.TILE.UP && W.depth > 0) World.msg(W, '昇降機。< で戻る。');
    else if (t === World.TILE.SHOP) {
      var id = Hub.shopAt(W.level, p.x, p.y);
      var shop = Hub.shopById(id);
      World.msg(W, (shop ? shop.name : '格納庫') + '。Enter で入る。');
    }
  }

  function attack(W, foe) {
    var p = W.player;
    var weapon = Inventory.weapon(W.inv);
    var res = Combat.playerAttack(W, p, foe, weapon);

    if (res.hits === 0) {
      World.msg(W, foe.name + 'への攻撃を外した。');
    } else {
      var s = foe.name + 'に' + res.damage + 'のダメージ。';
      if (res.crits.length) s = res.crits[0] + '! ' + s;
      if (res.mult > 1) s = '効いている! ' + s;
      World.msg(W, s);
    }
    if (res.killed) onKill(W, foe);
    return true;
  }

  function onKill(W, foe) {
    World.msg(W, foe.name + 'を倒した。');
    Lore.noteKill(W, foe);
    if (foe.unique) {
      W.uniquesKilled[foe.raceId] = true;
      World.msg(W, foe.name + 'は二度と現れない。');
      grantAdaptationIfDeep(W, foe);
      // 《門番》を倒すと深度100 への道が開く。最初から開いていると素通りできる
      if (foe.raceId === 'u-warden') Origin.openWardenShaft(W);
      // 《起源》を倒した。ここから帰還フェーズ (docs/07 §7.5)
      if (Monster.hasFlag(foe, 'FINAL')) beginReturn(W);
    }
    var exp = Player.expFromKill(foe, W.player.level);
    if (Player.gainExp(W.player, exp) > 0) {
      World.msg(W, 'レベル ' + W.player.level + ' に上がった。');
    }
    dropLoot(W, foe);
    World.reapDead(W);
  }

  /**
   * サイト最深部のユニークを倒すと《適合》を得る (docs/07 §7.2)。
   * 集めるアイテムではなく、潜り切った結果として身体が変わる形にしている。
   */
  function grantAdaptationIfDeep(W, foe) {
    if (!W.site || !W.site.adaptation) return;
    /* **そのサイトの守護ユニークからのみ**得る ([[D-69]])。
       「最深部で倒したユニークなら何でも」だと、たまたま深部に流れてきた
       別のユニークで《適合》が手に入り、守護を置いた意味が消える。 */
    if (!foe || !foe.guardian) return;
    if (!Site.grantAdaptation(W, W.site.adaptation)) return;

    var name = Site.ADAPTATION_NAME[W.site.adaptation];
    World.msg(W, '身体が変わっていく ―― 《適合:' + name + '》を得た。');
    World.msg(W, 'この環境は、もうあなたを害さない。(' +
                 Site.adaptationCount(W) + '/4)');
    recalc(W);
  }

  function dropLoot(W, foe) {
    dropParts(W, foe);

    // ユニークは必ず良いものを落とす
    if (foe.unique) {
      var prize = Item.makeForDepth(W.rng, W.depth + 10, W);
      if (prize) { prize.x = foe.x; prize.y = foe.y; W.items.push(prize); Lore.noteDrop(W, foe); }
      var money = Item.makeForDepth(W.rng, W.depth, W);
      if (money) { money.x = foe.x; money.y = foe.y; W.items.push(money); }
      return;
    }
    var chance = foe.base === 'human' ? 2 : 5;
    if (!W.rng.oneIn(chance)) return;
    var it = Item.makeForDepth(W.rng, W.depth, W);
    if (!it) return;
    it.x = foe.x; it.y = foe.y;
    W.items.push(it);
    Lore.noteDrop(W, foe);
  }

  /**
   * 移植に要るレアパーツ (docs/11 §11.4)。
   * **深部の敵だけが落とす。** 供給過多にすると工房が最適解になり、
   * 「良い装備は拾うもの」という本家の性質が壊れる。
   * 所持品にも重量にも入らない ―― 素材の管理をゲームにしない。
   */
  function dropParts(W, foe) {
    if (W.depth < PARTS_MIN_DEPTH) return;
    var chance = foe.unique ? 1 : (foe.base === 'automata' ? 12 : 25);
    if (chance > 1 && !W.rng.oneIn(chance)) return;
    var n = foe.unique ? W.rng.range(2, 4) : 1;
    Craft.addParts(W, n);
    World.msg(W, 'レアパーツを ' + n + ' 個回収した。(所持 ' + Craft.parts(W) + ')');
  }

  var PARTS_MIN_DEPTH = 15;

  /** 遠隔攻撃 (docs/02 §2.6)。 */
  function shoot(W, target) {
    var p = W.player;
    var launcher = W.inv.equip.launcher;
    if (!launcher) { World.msg(W, '射出器を装備していない。'); return false; }

    var ammo = null;
    for (var i = 0; i < W.inv.items.length; i++) {
      var it = W.inv.items[i];
      if (it.base === 'ammo' && it.ammoType === launcher.ammo) { ammo = it; break; }
    }
    if (!ammo) { World.msg(W, '合う弾体が無い。'); return false; }

    // 指定した目標があればそれを狙う。無ければ最も近い敵 ([[D-49]])。
    var foe = target || Target.pick(W);
    if (!foe) { World.msg(W, '狙う相手がいない。'); return false; }
    if (U.distCheb(foe.x, foe.y, p.x, p.y) > Combat.rangeOf(launcher)) {
      World.msg(W, '射程外だ。');
      return false;
    }

    var res = Combat.rangedAttack(W, p, foe, launcher, ammo);
    if (res.hit) {
      var s = foe.name + 'に' + res.damage + 'のダメージ。';
      if (res.crits.length) s = res.crits[0] + '! ' + s;
      World.msg(W, s);
    } else {
      World.msg(W, '外れた。');
    }

    // 弾体は 1/4 で壊れる。壊れなければ床に落ちる。
    Inventory.consume(W.inv, ammo, 1);
    if (!W.rng.oneIn(4)) {
      var spent = Item.create(W.rng, Data.get().itemsById[ammo.kindId], 1);
      spent.x = foe.x; spent.y = foe.y;
      W.items.push(spent);
    } else {
      res.broke = true;
    }

    if (res.killed) onKill(W, foe);
    return true;
  }

  function useAbility(W, id) {
    // 減圧下では精神系・生体系が使えない (発声を伴う — docs/08 §8.4)
    var a = Data.get().abilitiesById[id];
    if (a && !Env.canUseSystem(W, a.system)) {
      World.msg(W, '息ができない。声も出せない。');
      return false;
    }
    var r = Ability.use(W, W.player, id, Target.pick(W));
    if (!r.ok) { World.msg(W, r.reason); return false; }
    recalc(W);
    return true;
  }

  /** 母船から降りたときに着く深度。そのサイトの到達最深度(初回は最浅部)。 */
  function resumeDepth(W) {
    if (!W.site) W.site = Site.starting()[0];
    var reached = Site.deepestIn(W, W.site.id) || W.site.depthMin;
    return U.clamp(reached, W.site.depthMin, W.site.depthMax);
  }

  function descend(W) {
    if (World.getTile(W.level, W.player.x, W.player.y) !== World.TILE.DOWN) {
      World.msg(W, 'ここには降下シャフトが無い。');
      return false;
    }
    if (W.depth === 0) {
      // 母船からは、選んだサイトの到達最深度へ降りる
      enterLevel(W, resumeDepth(W), false);
      return true;
    }
    // そのサイトの最深部より下へは行けない。ここが終点。
    if (W.depth >= W.site.depthMax) {
      World.msg(W, 'これより下へは繋がっていない。' + W.site.name + 'はここが最深部だ。');
      return false;
    }
    enterLevel(W, W.depth + 1, false);
    return true;
  }

  /* ================= 帰還フェーズ (docs/07 §7.5) =================
   *
   * **撃破した瞬間ではなく、母船へ帰還して初めて勝利**とする。
   * 全力を使い切った状態で戻る緊張を、最後にもう一度だけ作る。
   *
   * 崩壊が進むので、階と階の間の構造は既に落ちている。
   * 昇降機は一度に RETURN_STEP 階ぶん上がる ([[D-70]])。
   * 100階を一段ずつ登らせるのは緊張ではなく作業になる。
   */
  var RETURN_STEP = 10;

  function beginReturn(W) {
    if (W.returning) return;
    W.returning = true;
    W.originSlain = true;
    World.msg(W, '《起源》は動きを止めた。');
    World.msg(W, '構造が崩れはじめている。**母船まで戻れ。**');
  }

  /** 帰還中か。 */
  function isReturning(W) { return !!W.returning; }

  /**
   * 崩壊の進行。帰還中は毎ターン、構造そのものが敵になる。
   * 敵を増やすのではなく環境で押す ―― 最後に問われるのは、
   * それまで身につけた「引き際」の判断であるべき。
   */
  function collapseTick(W) {
    if (!W.returning || W.depth <= 0 || W.dead) return;
    var env = W.level.env;
    if (!env) return;
    // 深いほど激しい。上がるほど落ち着く = 前進が報われる
    var severity = 1 + Math.floor(W.depth / 10);
    if (W.turn % 20 === 0) {
      /* 圧は**温度**でかける。ここまで来たプレイヤーは《適合》を4つ持っているので、
         減圧・被曝・汚染・監視はどれも効かない。それらで押しても何も起きない。
         温度は《適合》の対象外で、遮蔽と耐性で凌げる ([[D-54]])。 */
      env.temperature += severity;
      env.atmosphere = Math.max(0, env.atmosphere - 1);
    }
    if (W.turn % 50 === 0) {
      World.msg(W, '構造が軋んでいる。長くはもたない。');
    }
  }

  function ascend(W) {
    if (World.getTile(W.level, W.player.x, W.player.y) !== World.TILE.UP) {
      World.msg(W, 'ここには昇降機が無い。');
      return false;
    }
    if (W.depth <= 0) { World.msg(W, 'ここが最上層だ。'); return false; }

    // 帰還中は崩落した構造を一気に抜ける
    if (W.returning) {
      var next = W.depth - RETURN_STEP;
      if (next <= 0) { enterLevel(W, 0, false); return true; }
      enterLevel(W, next, true);
      World.msg(W, '崩れた層をまとめて抜けた。母船まで深度 ' + next + '。');
      return true;
    }

    // サイトの最浅部より上は母船へ戻る
    if (W.depth <= W.site.depthMin) { enterLevel(W, 0, false); return true; }
    enterLevel(W, W.depth - 1, true);
    return true;
  }

  /**
   * 端末に接続して1つ通す (docs/11 §11.3)。
   * **ターンを消費する。** タダで階に干渉させない。
   */
  function jack(W, opId) {
    var r = Net.jack(W, opId);
    if (!r.ok && r.reason && r.dealt === undefined) {
      World.msg(W, r.reason);          // そもそも試せなかった (端末が無い等)
      return false;
    }
    recalc(W);
    return true;
  }

  function pickup(W) {
    var p = W.player;
    var here = Item.itemsAt(W, p.x, p.y);
    if (here.length === 0) { World.msg(W, 'ここには何もない。'); return false; }

    var it = here[0];

    /* ログ断片は**所持品に入れない**。読んで記録するだけ (docs/07 §7.8)。
       読み物で所持枠を圧迫させない。持ち歩く判断もさせない。 */
    if (Fragment.isFragment(it)) {
      Fragment.collect(W, it);
      Item.removeFromFloor(W, it);
      return true;
    }

    var added = Inventory.add(W.inv, it);
    if (!added) { World.msg(W, '所持品がいっぱいだ。'); return false; }

    Item.removeFromFloor(W, it);
    if (it.amount) World.msg(W, it.amount + ' クレジットを拾った。');
    else World.msg(W, Sigil.name(W.knowledge, added) + 'を拾った。');
    recalc(W);
    return true;
  }

  function drop(W, it) {
    var p = W.player;
    Inventory.remove(W.inv, it);
    it.x = p.x; it.y = p.y;
    W.items.push(it);
    World.msg(W, Sigil.name(W.knowledge, it) + 'を置いた。');
    recalc(W);
    return true;
  }

  function use(W, it) {
    if (!it.effect) { World.msg(W, 'それは使えない。'); return false; }
    var consumed = Item.applyEffect(W, W.player, it);
    if (consumed) Inventory.consume(W.inv, it, 1);
    recalc(W);
    return true;
  }

  function equip(W, it) {
    var r = Inventory.equip(W.inv, it);
    if (!r.ok) { World.msg(W, r.reason); return false; }
    it.known = true;
    // 常時発動の刻印は装備した瞬間に分かる (docs/02 §2.8)
    Sigil.reveal(W, it, 'wear');
    World.msg(W, Sigil.name(W.knowledge, it) + 'を装備した。');
    if (it.tainted) World.msg(W, '……何かが軋んでいる。');
    recalc(W);
    return true;
  }

  function unequip(W, slot) {
    var r = Inventory.unequip(W.inv, slot);
    if (!r.ok) { World.msg(W, r.reason); return false; }
    World.msg(W, Sigil.name(W.knowledge, r.item) + 'を外した。');
    recalc(W);
    return true;
  }

  /* ---------- 休息と連続移動 ([[D-50]]) ---------- */

  /**
   * 休息。HP/SP が満ちるか、敵が見えるか、資源が尽きるまで待つ。
   * **ゲームターンは正しく消費する。** タダで回復させない。
   * @returns {number} 実際に休んだターン数
   */
  function rest(W, maxTurns) {
    var p = W.player;
    var n = 0;
    maxTurns = maxTurns || 500;
    while (n < maxTurns) {
      if (W.dead) break;
      if (visibleFoe(W)) { World.msg(W, '何かが見えた。'); break; }
      if (p.hp >= p.hpMax && (!p.system || p.sp >= p.spMax)) break;
      if (p.food <= 0) { World.msg(W, '空腹で休めない。'); break; }
      if (Env.sealDeficit(W) > 0) { World.msg(W, 'ここでは休めない。'); break; }
      step(W, { type: 'move', dx: 0, dy: 0 });
      n++;
    }
    if (n > 0) World.msg(W, n + ' ターン休息した。');
    else if (p.hp >= p.hpMax) World.msg(W, '休む必要は無い。');
    return n;
  }

  /**
   * 連続移動。壁・分岐・敵・アイテム・環境変化のいずれかで停止する。
   * @returns {number} 進んだ歩数
   */
  function run(W, dx, dy, maxSteps) {
    var n = 0;
    maxSteps = maxSteps || 60;
    while (n < maxSteps) {
      if (W.dead) break;
      if (visibleFoe(W)) { if (n) World.msg(W, '何かが見えた。'); break; }

      var p = W.player;
      var nx = p.x + dx, ny = p.y + dy;
      if (!World.walkable(W.level, nx, ny)) break;
      if (World.actorAt(W, nx, ny)) break;
      if (World.getTile(W.level, nx, ny) === World.TILE.TRAP) break;

      var before = { x: p.x, y: p.y };
      if (!step(W, { type: 'move', dx: dx, dy: dy })) break;
      if (p.x === before.x && p.y === before.y) break;
      n++;

      // 足元に何かある / 階段 / 分岐 で止まる
      if (Item.itemsAt(W, p.x, p.y).length) break;
      var tile = World.getTile(W.level, p.x, p.y);
      if (tile === World.TILE.DOWN || tile === World.TILE.UP ||
          tile === World.TILE.SHOP || tile === World.TILE.DOOR) break;
      if (isBranch(W, dx, dy)) break;
    }
    return n;
  }

  /* ================= 指定地点まで歩く (travel) ================= *
   *
   * **オートエクスプロアではない** ([[D-50]] は今も有効)。
   * 却下したのは「未知の場所を勝手に探索する」ことで、その理由は
   * 「歩いた距離で電力と食料を払わせる経済が無意味になる」からだった。
   *
   * ここは**プレイヤーが既に見た場所を指して歩く**だけで、
   * ターンも電力も食料も1歩ずつ同じだけ払う。本家 Angband の travel と同じ。
   * 経路は**既知のマスの上しか通らない** ―― 見ていない場所は使えない。
   */

  var TRAVEL_MAX = 200;

  /**
   * (tx,ty) までの経路を既知のマスだけで探す。
   * @returns {Array|null} [[dx,dy], ...] の手順。届かなければ null
   */
  function pathTo(W, tx, ty) {
    var lv = W.level, p = W.player;
    if (!World.inBounds(lv, tx, ty)) return null;
    if (p.x === tx && p.y === ty) return null;
    if (!World.walkable(lv, tx, ty)) return null;
    if (!World.hasFlag(lv, tx, ty, World.F.KNOWN)) return null;

    var prev = new Int32Array(lv.w * lv.h).fill(-1);
    var start = p.y * lv.w + p.x, goal = ty * lv.w + tx;
    prev[start] = start;

    var queue = [start], found = false;
    while (queue.length && !found) {
      var next = [];
      for (var q = 0; q < queue.length && !found; q++) {
        var cur = queue[q];
        var cx = cur % lv.w, cy = (cur - cx) / lv.w;
        for (var d = 0; d < U.DIRS.length; d++) {
          var nx = cx + U.DIRS[d].dx, ny = cy + U.DIRS[d].dy;
          if (!World.inBounds(lv, nx, ny)) continue;
          var ni = ny * lv.w + nx;
          if (prev[ni] !== -1) continue;
          if (!World.walkable(lv, nx, ny)) continue;
          // 見ていない場所は通れない。地図に無い道は使えない
          if (!World.hasFlag(lv, nx, ny, World.F.KNOWN)) continue;
          prev[ni] = cur;
          if (ni === goal) { found = true; break; }
          next.push(ni);
        }
      }
      queue = next;
    }
    if (prev[goal] === -1) return null;

    var steps = [], node = goal;
    while (node !== start) {
      var px = node % lv.w, py = (node - px) / lv.w;
      var pv = prev[node];
      var qx = pv % lv.w, qy = (pv - qx) / lv.w;
      steps.unshift([px - qx, py - qy]);
      node = pv;
      if (steps.length > TRAVEL_MAX) return null;
    }
    return steps;
  }

  /**
   * 指定地点まで歩く。**1歩ずつ通常の移動として処理する**ので、
   * ターン・電力・食料・環境の作用は歩いたぶんだけ正しく払われる。
   * 中断条件は run と同じ考え方 ―― 何かあったら止まる。
   * @returns {number} 実際に歩いた歩数
   */
  function travel(W, tx, ty) {
    var path = pathTo(W, tx, ty);
    if (!path) { World.msg(W, 'そこへの道が分からない。'); return 0; }

    var p = W.player, n = 0;
    for (var i = 0; i < path.length; i++) {
      if (W.dead) break;
      if (visibleFoe(W)) { if (n) World.msg(W, '何かが見えた。'); break; }

      var nx = p.x + path[i][0], ny = p.y + path[i][1];
      if (!World.walkable(W.level, nx, ny)) break;
      if (World.actorAt(W, nx, ny)) break;
      if (World.getTile(W.level, nx, ny) === World.TILE.TRAP) break;

      var before = { x: p.x, y: p.y, hp: p.hp };
      if (!step(W, { type: 'move', dx: path[i][0], dy: path[i][1] })) break;
      if (p.x === before.x && p.y === before.y) break;
      n++;

      /* HP が減ったら止まる。環境の作用(減圧・高熱)は敵が見えなくても効くので、
         これが無いと方舟の真空区画を削られながら歩き続けてしまう。 */
      if (p.hp < before.hp) { World.msg(W, '足を止めた。'); break; }

      // 足元に何かあれば止まる。通り過ぎさせない
      if (Item.itemsAt(W, p.x, p.y).length) break;
    }
    if (n) describeFloor(W);
    return n;
  }

  /** 進行方向の左右に道が開けているか(分岐)。 */
  function isBranch(W, dx, dy) {
    var p = W.player;
    var sides = (dx !== 0 && dy !== 0)
      ? [[dx, 0], [0, dy]]
      : (dx !== 0 ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]]);
    var open = 0;
    for (var i = 0; i < sides.length; i++) {
      if (World.walkable(W.level, p.x + sides[i][0], p.y + sides[i][1])) open++;
    }
    return open > 0;
  }

  function visibleFoe(W) {
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (a.asleep > 0) continue;                    // 眠っている敵では止まらない
      if (World.hasFlag(W.level, a.x, a.y, World.F.VISIBLE)) return a;
    }
    return null;
  }

  /**
   * コマンドを実行する。
   * @returns {boolean} ターンを消費したら true
   */
  function execPlayer(W, cmd) {
    if (W.dead) return false;
    switch (cmd.type) {
      case 'move':     return move(W, cmd.dx, cmd.dy);
      case 'descend':  return descend(W);
      case 'ascend':   return ascend(W);
      case 'pickup':   return pickup(W);
      case 'use':      return use(W, cmd.item);
      case 'equip':    return equip(W, cmd.item);
      case 'unequip':  return unequip(W, cmd.slot);
      case 'drop':     return drop(W, cmd.item);
      case 'shoot':    return shoot(W, cmd.target);
      case 'ability':  return useAbility(W, cmd.id);
      case 'jack':     return jack(W, cmd.id);
      case 'light':
        W.player.lightOff = !W.player.lightOff;
        World.msg(W, W.player.lightOff ? 'ライトを消した。' : 'ライトを点けた。');
        recalc(W);
        return true;
      default:
        return false;
    }
  }

  /* ---------- ゲームターンの維持処理 ---------- */

  function upkeep(W) {
    var p = W.player;
    Player.upkeep(W, p);

    // 環境の作用 (docs/08 §8.3)。HP とは独立に撤退理由を作る。
    Env.tick(W);
    Signature.tick(W);                           // サイト固有の機構 (昼夜・監視)

    // 状態異常はここでは減らさない。**アクター自身の手番**で減らす ([[D-93]])。

    // ライトの電力消費 (docs/00 §0.4-2)。刻印「省電」で伸びる。
    var l = W.inv.equip.light;
    if (l && l.cellUse && !p.lightOff && p.cells > 0) {
      var period = 10 + ((p.equipBonus && p.equipBonus.efficiency) || 0) * 8;
      if (W.turn % period === 0) {
        p.cells -= l.cellUse;
        if (p.cells <= 0) { p.cells = 0; World.msg(W, 'ライトが消えた。'); }
      }
    }

    // 帰投ビーコン
    if (W.recallPending > 0) {
      W.recallPending--;
      if (W.recallPending === 0) {
        World.msg(W, '回収された。');
        /* 復路も「そのサイトの到達最深度」へ。全体の到達最深度を使うと、
           浅いサイトのビーコンで別サイトの深部へ落ちてしまう ([[D-61]])。 */
        enterLevel(W, W.depth === 0 ? Cmd.resumeDepth(W) : 0, false);
      }
    }

    collapseTick(W);                     // 帰還中は構造そのものが敵になる
    recalc(W);
    // dead フラグも見る。死は一方通行 (HP が戻っても死亡は取り消せない)。
    if ((p.dead || p.hp <= 0) && !W.dead) die(W, W.lastAttacker || '不明');
  }

  /**
   * 勝利。記録を作る。墓碑(grave)と同じ枠を使い、中身だけを変える
   * ([[doc:ui]] §9.14) ―― 専用の画面機構を足さない。
   */
  function win(W) {
    W.won = true;
    W.returning = false;
    var end = Fragment.ending(W);
    W.grave = {
      won: true,
      devRun: !!W.devRun,
      seed: W.seed, turn: W.turn,
      depth: 0, depthMax: W.player.depthMax,
      level: W.player.level, exp: W.player.exp,
      cause: null,
      lineage: W.player.lineageName, role: W.player.roleName,
      credits: W.inv.credits,
      uniquesKilled: Object.keys(W.uniquesKilled || {}).length,
      loreFound: Fragment.foundCount(W),
      loreTotal: Fragment.placeable().length,
      loreRatio: end.ratio,
      ending: end.revealed.map(function (f) { return { title: f.title, text: f.text }; })
    };
    World.msg(W, '母船に帰り着いた。');
    World.msg(W, '《起源》は停止した。');
    return W.grave;
  }

  function die(W, cause) {
    W.dead = true;
    W.player.dead = true;
    W.grave = {
      seed: W.seed, turn: W.turn,
      depth: W.depth, depthMax: W.player.depthMax,
      level: W.player.level, exp: W.player.exp,
      cause: cause,
      lineage: W.player.lineageName, role: W.player.roleName,
      credits: W.inv.credits
    };
    World.msg(W, 'あなたは深度 ' + W.depth + ' で死亡した。');
  }

  /* ---------- 全体の駆動 ---------- */

  function step(W, cmd) {
    // 麻痺中は入力を受け付けない。手番だけが過ぎる ([[D-93]])。
    // 《自由行動》の刻印が無いと深部の麻痺は致命的になる (本家と同じ)。
    var frozen = !Actor.canAct(W.player);
    var consumed = frozen ? true : execPlayer(W, cmd);
    if (!consumed) return false;
    if (frozen) World.msg(W, '体が動かない。');

    // プレイヤーぶんのエネルギーはここで引く。tick には SKIP を返して
    // 二重に引かせない (Turn.tick の契約 — [[D-30]])。
    W.player.energy -= Turn.ACTION_COST;

    /* 状態異常は**そのアクター自身の手番**で減らす ([[D-93]])。
       ゲームターンで減らすと、速度110 の1手番 = 10ゲームターンなので
       書いた数字の10分の1しか続かない。 */
    Actor.tickTimers(W.player);

    function driveOthers(a) {
      if (a.kind === 'player') return Turn.SKIP;
      if (a.dead) return Turn.SKIP;
      if (Actor.canAct(a)) AI.act(W, a);               // 麻痺中もターンは消費する
      Actor.tickTimers(a);                             // 自分の手番が来たぶんだけ減る
      return Turn.ACTED;
    }

    var guard = 0;
    while (!W.dead && W.player.energy < Turn.ACTION_COST) {
      if (++guard > 10000) {
        var p = W.player;
        throw new Error('ターンが進行しない: energy=' + p.energy +
          ' speed=' + p.speed + ' effective=' + Turn.effectiveSpeed(p) +
          ' gain=' + Turn.gain(Turn.effectiveSpeed(p)) +
          ' weight=' + Inventory.totalWeight(W.inv) + '/' + Inventory.capacity(p, Env.envOf(W)) +
          ' penalty=' + Inventory.speedPenalty(p, W.inv, Env.envOf(W)));
      }
      Turn.tick(W, driveOthers);
      upkeep(W);
      World.reapDead(W);
    }
    refreshView(W);
    return true;
  }

  /** 新しいランを始める。 */
  function newGame(seed, lineageId, roleId) {
    var W = World.createWorld(seed);
    W.inv = Inventory.create();
    W.knowledge = Sigil.createKnowledge();
    W.knowledge.flavors = Sigil.assignFlavors(W.rng.derive('flavor'), RAW.flavors);
    W.lore = Lore.create();

    W.player = Player.create(W.seed, lineageId, roleId);
    World.addActor(W, W.player);

    grantStartingGear(W);
    W.progress = Site.createProgress();
    W.site = Site.starting()[0] || Site.all()[0];
    recalc(W);

    World.msg(W, 'STRATA — ' + W.player.lineageName + ' / ' + W.player.roleName);
    enterLevel(W, W.site.depthMin, false);
    return W;
  }

  /** 初期装備。ロールによって変える。 */
  function grantStartingGear(W) {
    var db = Data.get();
    var p = W.player;

    var weapon = { marine: 'pry-bar', marksman: 'service-knife', ghost: 'service-knife',
                   psion: 'service-knife', technician: 'cutting-torch',
                   xenobiologist: 'service-knife', scavenger: 'pry-bar',
                   netrunner: 'service-knife' }[p.role] || 'pry-bar';

    equipNew(W, db.itemsById[weapon]);
    equipNew(W, db.itemsById['work-suit']);
    equipNew(W, db.itemsById['hand-lamp']);

    if (p.role === 'marksman') {
      equipNew(W, db.itemsById['scrap-slinger']);
      Inventory.add(W.inv, Item.create(W.rng, db.itemsById['scrap-slug'], 25));
    }

    Inventory.add(W.inv, Item.create(W.rng, db.itemsById['ration'], 3));
    Inventory.add(W.inv, Item.create(W.rng, db.itemsById['medgel'], 2));
    Inventory.add(W.inv, Item.create(W.rng, db.itemsById['power-cell'], 2));
    W.inv.credits = 200;

    // 初期能力を1つ習得しておく (能力系ロールが何もできない状態で始まらないように)
    if (p.system) {
      var first = Ability.learnable(p)[0];
      if (first) p.abilities.push(first.id);
    }
  }

  function equipNew(W, kind) {
    if (!kind) return null;
    var it = Item.create(W.rng, kind, 1);
    it.known = true;
    Inventory.equip(W.inv, it);
    Sigil.learnKind(W, it.kindId);
    return it;
  }

  /** 降下先のサイトを選ぶ。母船でのみ。 */
  function selectSite(W, siteId) {
    var site = Site.byId(siteId);
    if (!site) return { ok: false, reason: 'そのような場所は無い。' };
    var locked = Site.lockReason(W, site);
    if (locked) return { ok: false, reason: locked };
    W.site = site;
    World.msg(W, site.name + 'を降下先にした。');
    return { ok: true, site: site };
  }

  return {
    newGame: newGame, enterLevel: enterLevel, step: step, execPlayer: execPlayer,
    selectSite: selectSite, grantAdaptationIfDeep: grantAdaptationIfDeep,
    upkeep: upkeep, recalc: recalc, populateFixed: populateFixed,
    dropParts: dropParts, PARTS_MIN_DEPTH: PARTS_MIN_DEPTH, refreshView: refreshView, die: die, onKill: onKill,
    computeFeeling: computeFeeling, feelingText: feelingText,
    DANGER_TEXT: DANGER_TEXT, LOOT_TEXT: LOOT_TEXT, TRAPS: TRAPS,
    move: move, attack: attack, shoot: shoot, pickup: pickup, use: use,
    ascend: ascend, descend: descend, jack: jack,
    equip: equip, unequip: unequip, drop: drop, useAbility: useAbility,
    rest: rest, run: run, travel: travel, pathTo: pathTo,
    TRAVEL_MAX: TRAVEL_MAX, visibleFoe: visibleFoe, resumeDepth: resumeDepth,
    beginReturn: beginReturn, isReturning: isReturning, collapseTick: collapseTick,
    win: win, RETURN_STEP: RETURN_STEP
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Cmd;
