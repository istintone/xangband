/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* devstart.js — 開発用の起動オプション。docs/07 §7.9 ([[D-66]])。DOM 非依存。
 *
 * 1ラン15〜40時間の通しプレイを実装のたびに繰り返すことはできない。
 * 終端(深度80/98/99/100 と帰還)だけを繰り返し通せる入口が要る。
 *
 *   ?dev=depth:99,adapt:all,gear:deep,lore:80
 *
 * **開発モードで始めたランはスコアに残さない。** 記録の意味が壊れるため。
 * 手触りの検証はこれでは代替できない。通しプレイは M5 で行う。
 */
'use strict';

var DevStart = (function () {

  /** "depth:99,adapt:all" -> { depth: '99', adapt: 'all' } */
  function parse(spec) {
    var out = {};
    if (!spec) return out;
    var parts = String(spec).split(',');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split(':');
      if (kv.length < 2) continue;
      out[kv[0].trim()] = kv.slice(1).join(':').trim();
    }
    return out;
  }

  var ADAPTS = ['vacuum', 'radiation', 'contamination', 'watch'];

  /**
   * 開発指定を世界に適用する。
   * @param W  Cmd.newGame で作った直後の世界
   * @param spec 文字列 (URL の ?dev= の値)
   * @returns {object} 何を適用したかの記録
   */
  function apply(W, spec) {
    var opt = parse(spec);
    var applied = { devRun: true };
    W.devRun = true;

    // --- 《適合》 ---
    if (opt.adapt) {
      var want = opt.adapt === 'all' ? ADAPTS : opt.adapt.split('+');
      for (var i = 0; i < want.length; i++) {
        if (ADAPTS.indexOf(want[i]) !== -1) Site.grantAdaptation(W, want[i]);
      }
      applied.adapt = Site.adaptationCount(W);
    }

    // --- ログ断片の収集率 (勝利画面の分岐確認用) ---
    if (opt.lore) {
      var pct = Math.max(0, Math.min(100, parseInt(opt.lore, 10) || 0));
      var pool = Fragment.placeable();
      var n = Math.round(pool.length * pct / 100);
      for (var f = 0; f < n; f++) W.loreFound[pool[f].id] = true;
      applied.lore = n;
    }

    // --- 装備と成長 ---
    if (opt.gear) applied.gear = outfit(W, opt.gear, opt.depth);

    /* --- 検証用の下駄 ---
       gear:deep は「実際に店に在るもの」しか買わないので、
       深部の装備がまだ存在しない現状では裸同然になる。
       終端の**機構**を確かめたいときだけ god:1 で耐久を底上げする。
       これはバランスの検証には使えない。使ったことは記録に残る。 */
    if (opt.god) {
      var p = W.player;
      p.hpMax = Math.max(p.hpMax, 3000);
      p.hp = p.hpMax;
      applied.god = true;
      W.godRun = true;
      /* 深部の武器がまだ存在しないので、検証用の1本をここで作る。
         **data に置かない**。名前で「これは内容ではない」と分かるようにする。 */
      Cmd.equip(W, Inventory.add(W.inv, {
        uid: Item.nextUid(), kindId: null, base: 'weapon',
        name: '《検証用の楔》', glyph: '|', color: 'red', slot: 'weapon',
        stackable: false, count: 1, weight: 0, known: true, sigils: [],
        dice: '30d10', toHit: 60, toDam: 40, ac: 40, seal: 4, x: 0, y: 0
      }));
      Cmd.recalc(W);
      p.hp = p.hpMax;
    }

    // --- 深度 ---
    if (opt.depth) {
      var d = Math.max(0, Math.min(100, parseInt(opt.depth, 10) || 0));
      var site = opt.site ? Site.byId(opt.site) : siteForDepth(W, d);
      if (site) W.site = site;
      if (d > 0) {
        W.player.depthMax = d;
        Site.noteDepth(W, W.site.id, d);
      }
      Cmd.enterLevel(W, d, false);
      applied.depth = d;
      applied.site = W.site.id;
    }

    World.msg(W, '[開発モード] ' + spec + ' ―― この記録は残らない。');
    return applied;
  }

  /** その深度を担当するサイト。《起源》が使えるならそれを優先する。 */
  function siteForDepth(W, depth) {
    var list = Site.availableAt(depth);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === 'origin' && !Site.lockReason(W, list[i])) return list[i];
    }
    return list[0] || Site.starting()[0];
  }

  /**
   * 深度相応に育てて装備させる。
   * 店の品揃えは到達最深度で決まるので、先にそれを上げてから買う。
   */
  function outfit(W, level, depthSpec) {
    var depth = Math.max(1, Math.min(100, parseInt(depthSpec, 10) || 50));
    var target = Math.min(Player.MAX_LEVEL, level === 'deep' ? depth : Math.floor(depth / 2));

    Player.gainExp(W.player, Player.expNeeded(Math.max(1, target - 1), W.player.expFactor));
    W.player.depthMax = depth;
    W.inv.credits += depth * 400;

    Cmd.enterLevel(W, 0, false);          // 母船で仕入れる
    var rng = W.rng.derive('dev/outfit');
    for (var round = 0; round < 40; round++) {
      var bought = false;
      for (var s = 0; s < Hub.SHOPS.length; s++) {
        var shop = Hub.SHOPS[s];
        var stock = (W.shops && W.shops[shop.id]) || [];
        for (var i = 0; i < stock.length; i++) {
          if (Hub.buyPrice(W, stock[i]) > W.inv.credits) continue;
          if (Hub.buy(W, shop.id, i).ok) { bought = true; break; }
        }
      }
      if (!bought) break;
    }
    for (var r = 0; r < 3; r++) {
      var carried = W.inv.items.slice();
      for (var c = 0; c < carried.length; c++) {
        if (carried[c].slot) Cmd.equip(W, carried[c]);
      }
    }
    Cmd.recalc(W);
    W.player.hp = W.player.hpMax;
    return { level: W.player.level, ac: W.player.ac, seal: W.player.seal };
  }

  return { parse: parse, apply: apply, outfit: outfit, ADAPTS: ADAPTS };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = DevStart;
