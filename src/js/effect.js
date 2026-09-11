/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* effect.js — 効果の解決。アイテムと能力が共有する。DOM 非依存。
 *
 * 書式は "name:arg1:arg2"。item.js と ability.js の両方から呼ぶので、
 * 「アンプルで回復」と「能力で回復」を二重実装しない。
 */
'use strict';

var Effect = (function () {

  /**
   * @param target 射線系の効果で狙う相手 (null なら自動で最も近い敵)
   * @returns {boolean} 効果が成立したら true (= アイテムを消費する)
   */
  function apply(W, p, spec, target) {
    var parts = String(spec || '').split(':');
    var name = parts[0];
    var a1 = parts[1], a2 = parts[2], a3 = parts[3];

    switch (name) {
      case 'heal': {
        var amount = Data.rollDice(W.rng, a1);
        var before = p.hp;
        Actor.heal(p, amount);
        World.msg(W, '傷が塞がった。(' + (p.hp - before) + ')');
        return true;
      }
      case 'haste':
        Actor.addTimer(p, 'haste', parseInt(a1, 10) || 20);
        World.msg(W, '体が軽くなった。');
        return true;

      case 'cure':
        if (a1 === 'poison') { p.timers.poison = 0; p.exposure = 0; World.msg(W, '汚染が中和された。'); }
        return true;

      case 'restore':
        Stat.restore(p);
        World.msg(W, '身体の状態が元に戻った。');
        return true;

      case 'stat': {
        if (Stat.raise(p.stats, a1)) {
          World.msg(W, STAT_NAME[a1] + 'が上がった。(' + Stat.label(p.stats[a1]) + ')');
        } else {
          World.msg(W, 'これ以上は上がらない。');
        }
        return true;
      }

      case 'feed':
        p.food = Math.min(12000, p.food + (parseInt(a1, 10) || 2000));
        World.msg(W, '食事をとった。');
        return true;

      case 'cell':
        p.cells += parseInt(a1, 10) || 500;
        World.msg(W, 'セルを装填した。(電力 ' + p.cells + ')');
        return true;

      case 'map':
        revealAround(W, p.x, p.y, parseInt(a1, 10) || 20);
        World.msg(W, '周囲の構造を読み取った。');
        return true;

      case 'detect':
        return detect(W, p, a1, parseInt(a2, 10) || 25);

      case 'blink':
        if (teleport(W, p, parseInt(a1, 10) || 10)) World.msg(W, '空間がねじれた。');
        return true;

      case 'identify':
        return identifyOne(W);

      case 'remove-taint':
        return removeTaint(W);

      case 'repair':
        return repairSeal(W);

      case 'unlock':
        return unlockAround(W, p, parseInt(a1, 10) || 8);

      case 'bolt':
        return bolt(W, p, a1, a2, target);

      case 'ball':
        return ball(W, p, a1, a2, parseInt(a3, 10) || 2);

      case 'afflict':
        return afflict(W, p, a1, parseInt(a2, 10) || 10, parseInt(a3, 10) || 1, target);

      case 'bind':
        return bind(W, p, parseInt(a1, 10) || 20, parseInt(a2, 10) || 4, target);

      case 'recall':
        return recall(W, p);

      case 'terminal':
        return makeTerminal(W, p);

      case 'restore-cog':
        return restoreCog(W, p, parseInt(a1, 10) || 5);

      default:
        World.msg(W, '何も起きなかった。');
        return true;
    }
  }

  var STAT_NAME = { str: '体力', int: '演算', wis: '意志', dex: '反射', con: '耐久', chr: '統率' };

  /* ---------- 個々の効果 ---------- */

  function revealAround(W, cx, cy, r) {
    var lv = W.level;
    for (var y = cy - r; y <= cy + r; y++) {
      for (var x = cx - r; x <= cx + r; x++) {
        if (World.inBounds(lv, x, y)) World.addFlag(lv, x, y, World.F.KNOWN);
      }
    }
  }

  /** 敵/アイテムの検出。地形は明かさない。 */
  function detect(W, p, what, r) {
    var found = 0, i;
    if (what === 'life' || what === 'all') {
      for (i = 0; i < W.actors.length; i++) {
        var a = W.actors[i];
        if (a.dead || a.kind === 'player') continue;
        if (U.distCheb(a.x, a.y, p.x, p.y) > r) continue;
        if (what === 'life' && a.base === 'automata') continue;   // 機械は生体感知に映らない
        a.detected = true;
        Lore.noteSeen(W, a);
        found++;
      }
    }
    if (what === 'item' || what === 'all') {
      for (i = 0; i < W.items.length; i++) {
        var it = W.items[i];
        if (U.distCheb(it.x, it.y, p.x, p.y) > r) continue;
        World.addFlag(W.level, it.x, it.y, World.F.KNOWN);
        found++;
      }
    }
    World.msg(W, found > 0 ? found + ' 件を検出した。' : '何も検出できなかった。');
    return true;
  }

  function teleport(W, a, dist) {
    for (var t = 0; t < 100; t++) {
      var x = a.x + W.rng.range(-dist, dist);
      var y = a.y + W.rng.range(-dist, dist);
      if (!World.walkable(W.level, x, y)) continue;
      if (World.actorAt(W, x, y)) continue;
      a.x = x; a.y = y;
      return true;
    }
    return false;
  }

  /** 未解析の装備を1つ解析する。 */
  function identifyOne(W) {
    var candidates = [];
    var i;
    for (i = 0; i < Inventory.SLOTS.length; i++) {
      var e = W.inv.equip[Inventory.SLOTS[i]];
      if (e && !Sigil.fullyKnown(W.knowledge, e)) candidates.push(e);
    }
    for (i = 0; i < W.inv.items.length; i++) {
      var it = W.inv.items[i];
      if (it.slot && !Sigil.fullyKnown(W.knowledge, it)) candidates.push(it);
    }
    if (candidates.length === 0) { World.msg(W, '解析するものが無い。'); return false; }
    var target = candidates[0];
    Sigil.analyze(W, target);
    target.known = true;
    World.msg(W, Sigil.name(W.knowledge, target) + 'を解析した。');
    return true;
  }

  /** 汚染ファームを1つ剥がす。 */
  function removeTaint(W) {
    var db = Data.get();
    for (var i = 0; i < Inventory.SLOTS.length; i++) {
      var it = W.inv.equip[Inventory.SLOTS[i]];
      if (!it || !it.sigils) continue;
      for (var j = 0; j < it.sigils.length; j++) {
        var s = db.sigilsById[it.sigils[j]];
        if (s && s.taint) {
          it.sigils.splice(j, 1);
          if (!it.sigils.some(function (id) { var q = db.sigilsById[id]; return q && q.taint; })) {
            it.tainted = false;
          }
          World.msg(W, '《' + s.name + '》を剥がした。');
          return true;
        }
      }
    }
    World.msg(W, '剥がすべき汚染ファームが無い。');
    return false;
  }

  /** スーツの気密損傷を回復する。 */
  function repairSeal(W) {
    var it = W.inv.equip.body;
    if (!it || !it.damaged) { World.msg(W, '修理するものが無い。'); return false; }
    it.ac += it.damaged;
    it.damaged = 0;
    World.msg(W, Sigil.name(W.knowledge, it) + 'を修復した。');
    return true;
  }

  /** 周囲の扉を開き、設備障害を無効化する。 */
  function unlockAround(W, p, r) {
    var lv = W.level, n = 0;
    for (var y = p.y - r; y <= p.y + r; y++) {
      for (var x = p.x - r; x <= p.x + r; x++) {
        if (!World.inBounds(lv, x, y)) continue;
        var t = World.getTile(lv, x, y);
        if (t === World.TILE.DOOR || t === World.TILE.TRAP) {
          World.setTile(lv, x, y, World.TILE.FLOOR);
          n++;
        }
      }
    }
    World.msg(W, n > 0 ? n + ' 箇所を解除した。' : '解除するものが無い。');
    return true;
  }

  /** 射線上の最初の敵に当たる単体攻撃。 */
  function bolt(W, p, element, dice, target) {
    var foe = target || nearestVisible(W, p);
    if (!foe) { World.msg(W, '狙う相手がいない。'); return true; }
    var dmg = Data.rollDice(W.rng, dice);
    if (Combat.monsterResists(foe, element)) {
      dmg = Math.max(1, Math.floor(dmg / 3));
      World.msg(W, foe.name + 'には効きが悪い。');
    }
    World.msg(W, foe.name + 'に' + dmg + 'のダメージ。');
    Lore.noteAttacked(W, foe);
    if (Actor.damage(foe, dmg)) killed(W, foe);
    return true;
  }

  /** 対象を中心にした範囲攻撃。 */
  function ball(W, p, element, dice, radius) {
    var center = nearestVisible(W, p) || p;
    var hit = 0;
    for (var i = W.actors.length - 1; i >= 0; i--) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (U.distCheb(a.x, a.y, center.x, center.y) > radius) continue;
      var dmg = Data.rollDice(W.rng, dice);
      if (Combat.monsterResists(a, element)) dmg = Math.max(1, Math.floor(dmg / 3));
      Lore.noteAttacked(W, a);
      if (Actor.damage(a, dmg)) killed(W, a);
      hit++;
    }
    World.msg(W, hit > 0 ? hit + ' 体を巻き込んだ。' : '何も巻き込めなかった。');
    return true;
  }

  /** 状態異常を与える。radius 1 なら単体。 */
  /* 行動を奪う状態異常。これらだけ抵抗判定を通す ([[D-94]])。
     毒は含めない ―― 継続ダメージは行動を奪わないので、固定の問題と無関係。 */
  var DISABLING = { paralyzed: 1, confused: 1, afraid: 1, blind: 1, slow: 1 };

  /**
   * 状態異常が通る確率 (%) ([[D-94]])。
   *   clamp(90 - max(0, 相手のレベル - 自分のレベル) * 1.5, 5, 90)
   *   ユニークは更に半分
   *
   * 判定が無いと「麻痺させて殴るだけ」が最適解になる ――
   * 実測で終盤の関門が**最も易しく**なっていた。
   * かといって完全耐性にすると道具が死に、転移で逃げる相手を
   * 捕まえられない問題 (`[[Q-24]]`) に逆戻りする。
   */
  function landChance(p, mon) {
    var gap = Math.max(0, (mon.level || 1) - (p.level || 1));
    var pct = U.clamp(Math.round(90 - gap * 1.5), 5, 90);
    if (mon.unique || Monster.hasFlag(mon, 'UNIQUE')) pct = Math.round(pct / 2);
    return U.clamp(pct, 1, 90);
  }

  function afflict(W, p, timer, turns, radius, target) {
    var center = target || nearestVisible(W, p);
    if (!center) { World.msg(W, '狙う相手がいない。'); return true; }
    var n = 0, resisted = 0;
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (U.distCheb(a.x, a.y, center.x, center.y) >= radius) continue;
      if (Monster.hasFlag(a, 'NO_FEAR') && timer === 'afraid') continue;
      if (a.base === 'automata' && (timer === 'afraid' || timer === 'confused')) continue;
      if (DISABLING[timer] && W.rng.int(100) >= landChance(p, a)) { resisted++; continue; }
      Actor.addTimer(a, timer, turns);
      n++;
    }
    World.msg(W, n > 0 ? n + ' 体に効いた。'
                       : (resisted ? '抵抗された。' : '効かなかった。'));
    return true;
  }

  /**
   * 《係留》([[D-95]])。転移だけを打ち消す。**行動は奪わない**。
   *
   * 「捕まえられない」への答えは相手を止めることではなく逃げ道を塞ぐこと ――
   * 麻痺で代用すると、効けば強すぎ、弱めれば捕まえられないの二択にしかならない。
   * 行動を奪わないので、抵抗判定は通さない(必ず効く)。
   */
  function bind(W, p, turns, radius, target) {
    var center = target || nearestVisible(W, p);
    if (!center) { World.msg(W, '狙う相手がいない。'); return true; }
    var n = 0;
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (U.distCheb(a.x, a.y, center.x, center.y) > radius) continue;
      Actor.addTimer(a, 'bound', turns);
      n++;
    }
    World.msg(W, n > 0 ? n + ' 体の転移座標を埋めた。' : '届く相手がいない。');
    return true;
  }

  function recall(W, p) {
    if (W.depth === 0) { World.msg(W, 'すでに母船にいる。'); return false; }
    W.recallPending = W.recallPending ? 0 : W.rng.range(15, 35);
    World.msg(W, W.recallPending ? '帰投信号を送った。まもなく回収される。' : '帰投信号を取り消した。');
    return true;
  }

  /**
   * 認知を押し戻す (docs/11 §11.2)。
   * 本来は時間でしか戻らない資源なので、**薬は深部でしか手に入らない**。
   * 押し戻しただけで休んではいないため、上限は超えない。
   */
  function restoreCog(W, p, amount) {
    if (p.cog >= p.cogMax) { World.msg(W, '認知は満ちている。'); return false; }
    p.cog = Math.min(p.cogMax, p.cog + amount);
    World.msg(W, '思考がはっきりした。(認知 ' + p.cog + '/' + p.cogMax + ')');
    return true;
  }

  /**
   * 足元に仮の端末を立てる (docs/11 §11.3)。
   * **接続者が端末を待つだけの存在にならないため**の能力。
   * 立てた端末は残る ―― その階に戻る理由になる。
   */
  function makeTerminal(W, p) {
    var t = World.getTile(W.level, p.x, p.y);
    if (t === World.TILE.TERM) { World.msg(W, 'ここには既に端末がある。'); return false; }
    if (t !== World.TILE.FLOOR) { World.msg(W, 'ここには立てられない。'); return false; }
    World.setTile(W.level, p.x, p.y, World.TILE.TERM);
    W.level.terminal = { x: p.x, y: p.y };
    World.msg(W, '仮設端末を立てた。J で接続できる。');
    return true;
  }

  function nearestVisible(W, p) {
    var best = null, bd = 999;
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (!World.hasFlag(W.level, a.x, a.y, World.F.VISIBLE)) continue;
      if (!FOV.lineOfSight(W.level, p.x, p.y, a.x, a.y)) continue;
      var d = U.distCheb(a.x, a.y, p.x, p.y);
      if (d < bd) { bd = d; best = a; }
    }
    return best;
  }

  /** 効果で敵が死んだときの後始末。cmd.js の attack と同じ処理を通す。 */
  function killed(W, foe) {
    World.msg(W, foe.name + 'を倒した。');
    Lore.noteKill(W, foe);
    var exp = Player.expFromKill(foe, W.player.level);
    if (Player.gainExp(W.player, exp) > 0) {
      World.msg(W, 'レベル ' + W.player.level + ' に上がった。');
    }
  }

  /* 実装済みの効果種別。データ側の綴り間違いを検査するために公開する。
     `restore-cog` を data に書いたのに未実装で、**黙って何も起きなかった**。
     「何も起きなかった」は成功と区別がつかないので、データ検査で止める。 */
  var KINDS = ['heal', 'haste', 'cure', 'restore', 'stat', 'feed', 'cell', 'map',
               'detect', 'blink', 'identify', 'remove-taint', 'repair', 'unlock',
               'bolt', 'ball', 'afflict', 'bind', 'recall', 'terminal', 'restore-cog'];

  return {
    KINDS: KINDS,
    apply: apply, makeTerminal: makeTerminal, restoreCog: restoreCog, revealAround: revealAround, teleport: teleport,
    nearestVisible: nearestVisible, killed: killed, STAT_NAME: STAT_NAME,
    landChance: landChance, DISABLING: DISABLING
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Effect;
