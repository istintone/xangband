/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* hub.js — 母船《アンカー》。交易区・格納庫・降下。docs/03 §3.6。DOM 非依存。
 *
 * 深度0 の固定マップとして表現する ([[D-39]])。町を特別扱いしないので、
 * 移動・描画・セーブの仕組みがそのまま使える。
 */
'use strict';

var Hub = (function () {

  /* 交易区6区画 (docs/03 §3.6)。bases が扱う品目。 */
  var SHOPS = [
    { id: 'supply',  name: '補給所', glyph: '1', bases: ['ration', 'cell', 'ampule'], depthBias: 0 },
    { id: 'arms',    name: '兵装廠', glyph: '2', bases: ['weapon', 'launcher', 'ammo'], depthBias: 0 },
    { id: 'armour',  name: '装甲廠', glyph: '3', bases: ['suit', 'plate'], depthBias: 0 },
    { id: 'chem',    name: '調剤室', glyph: '4', bases: ['ampule'], depthBias: 2 },
    { id: 'info',    name: '情報屋', glyph: '5', bases: ['protocol'], depthBias: 2, services: ['analyze', 'cure'] },
    { id: 'works',   name: '工房',   glyph: '6', bases: ['implant', 'neurallink', 'light'], depthBias: 4, services: ['repair', 'transplant'] }
  ];

  var MAP_W = 60, MAP_H = 24;

  /**
   * 母船の階層を作る。固定レイアウトなので毎回同じ。
   * 中央に降下ポッド、周囲に交易区6区画と格納庫。
   */
  function createLevel() {
    var lv = World.createLevel(MAP_W, MAP_H);
    lv.depth = 0;
    lv.isHub = true;

    // 全体を床にして外周を壁で囲む
    for (var y = 1; y < MAP_H - 1; y++) {
      for (var x = 1; x < MAP_W - 1; x++) {
        World.setTile(lv, x, y, World.TILE.FLOOR);
        World.addFlag(lv, x, y, World.F.GLOW | World.F.KNOWN);
      }
    }

    // 交易区は上下に3つずつ。入口タイルを置く。
    lv.shopDoors = {};
    for (var i = 0; i < SHOPS.length; i++) {
      var col = 8 + (i % 3) * 18;
      var row = (i < 3) ? 4 : MAP_H - 5;
      buildStall(lv, col, row, SHOPS[i]);
      lv.shopDoors[col + ',' + row] = SHOPS[i].id;
    }

    // 中央に降下ポッド
    var cx = MAP_W >> 1, cy = MAP_H >> 1;
    World.setTile(lv, cx, cy, World.TILE.DOWN);
    lv.down = { x: cx, y: cy };
    lv.up = { x: cx, y: cy };          // 母船が最上位。上には行けない

    // 格納庫(倉庫)
    lv.homeAt = { x: cx - 6, y: cy };
    World.setTile(lv, lv.homeAt.x, lv.homeAt.y, World.TILE.SHOP);
    lv.shopDoors[lv.homeAt.x + ',' + lv.homeAt.y] = 'home';

    lv.rooms = [{ x1: 1, y1: 1, x2: MAP_W - 2, y2: MAP_H - 2 }];
    return lv;
  }

  /** 店の区画。3x3 の箱に入口を1つ。 */
  function buildStall(lv, cx, cy, shop) {
    for (var y = cy - 1; y <= cy + 1; y++) {
      for (var x = cx - 2; x <= cx + 2; x++) World.setTile(lv, x, y, World.TILE.WALL);
    }
    World.setTile(lv, cx, cy, World.TILE.SHOP);
  }

  function shopById(id) {
    for (var i = 0; i < SHOPS.length; i++) if (SHOPS[i].id === id) return SHOPS[i];
    return null;
  }

  /** その座標に店があれば id を返す。 */
  function shopAt(lv, x, y) {
    if (!lv.shopDoors) return null;
    return lv.shopDoors[x + ',' + y] || null;
  }

  /* ---------- 在庫 ---------- */

  /**
   * 在庫を作り直す。到達最深度に応じて品揃えが伸びる (docs/02 §2.8)。
   * 母船に戻るたびに一定確率で入れ替わる。
   */
  function restock(W, force) {
    if (!W.shops) W.shops = {};
    var depth = Math.max(1, W.player.depthMax);

    for (var i = 0; i < SHOPS.length; i++) {
      var s = SHOPS[i];
      if (!force && W.shops[s.id] && !W.rng.oneIn(3)) continue;

      var rng = W.rng.derive('shop/' + s.id + '/' + W.turn);
      var stock = [];
      var n = 6 + rng.int(6);
      for (var k = 0; k < n; k++) {
        var pool = Data.get().items.filter(function (it) {
          return s.bases.indexOf(it.base) !== -1;
        });
        var kind = Data.allocate(rng, pool, Math.min(100, depth + s.depthBias));
        if (!kind) continue;
        var it = Item.create(rng, kind, 1);
        if (it.stackable) it.count = rng.range(2, 8);
        // 店売り品は解析済み。値段が付くものしか置けないため。
        it.known = true;
        Sigil.learnKind(W, it.kindId);
        stock.push(it);
      }
      W.shops[s.id] = stock;
    }
  }

  /* ---------- 価格 ---------- */

  /** 統率で買値が下がる。本家の CHR と同じ役割。 */
  function priceFactor(p) {
    var chr = Stat.effective(p, 'chr');
    return 1.4 - Math.min(0.5, Stat.index(chr) * 0.012);
  }

  /** 買値は**1個あたり**。購入は1個ずつなので、表示と実際を一致させる。 */
  function buyPrice(W, it) {
    return Math.max(1, Math.round(unitValue(W, it) * priceFactor(W.player)));
  }

  /** 売値は買値よりずっと安い。稼ぎ手段にしない。持っている数ぶんまとめて売る。 */
  function sellPrice(W, it) {
    return Math.max(1, Math.round(unitValue(W, it) * (it.count || 1) * 0.25));
  }

  /** アイテム1個あたりの価値。刻印の価値を合算する。 */
  function unitValue(W, it) {
    var v = it.cost || 1;
    var db = Data.get();
    for (var i = 0; i < (it.sigils || []).length; i++) {
      var s = db.sigilsById[it.sigils[i]];
      if (s) v += s.value * Math.max(1, it.pval || 1);
    }
    v += (it.toHit || 0) * 30 + (it.toDam || 0) * 40 + (it.ac || 0) * 25;
    return Math.max(1, Math.round(v));
  }

  /** 山全体の価値。解析費用の算定などに使う。 */
  function valueOf(W, it) { return unitValue(W, it) * (it.count || 1); }

  function buy(W, shopId, index) {
    var stock = W.shops[shopId];
    if (!stock || !stock[index]) return { ok: false, reason: 'その品は無い。' };
    var it = stock[index];
    var price = buyPrice(W, it);
    if (W.inv.credits < price) return { ok: false, reason: 'クレジットが足りない。' };

    var copy = JSON.parse(JSON.stringify(it));
    copy.uid = Item.nextUid();
    if (copy.stackable) copy.count = 1;
    if (!Inventory.add(W.inv, copy)) return { ok: false, reason: '所持品がいっぱいだ。' };

    W.inv.credits -= price;
    if (it.stackable && it.count > 1) it.count--;
    else stock.splice(index, 1);
    return { ok: true, item: copy, price: price };
  }

  function sell(W, shopId, it) {
    var shop = shopById(shopId);
    if (!shop) return { ok: false, reason: 'ここでは買い取らない。' };
    if (shop.bases.indexOf(it.base) === -1) return { ok: false, reason: 'ここでは扱っていない。' };

    var price = sellPrice(W, it);
    Inventory.remove(W.inv, it);
    W.inv.credits += price;
    // 売った品は解析される = 知識になる
    Sigil.analyze(W, it);
    return { ok: true, price: price };
  }

  /* ---------- 役務 ---------- */

  function analyzeService(W, it) {
    var price = 120 + Math.round(valueOf(W, it) * 0.05);
    if (W.inv.credits < price) return { ok: false, reason: 'クレジットが足りない。' };
    W.inv.credits -= price;
    Sigil.analyze(W, it);
    it.known = true;
    return { ok: true, price: price };
  }

  function cureService(W) {
    var price = 200;
    if (W.inv.credits < price) return { ok: false, reason: 'クレジットが足りない。' };
    W.inv.credits -= price;
    Stat.restore(W.player);
    W.player.exposure = 0;
    W.player.timers.poison = 0;
    return { ok: true, price: price };
  }

  function repairService(W) {
    var damaged = Inventory.SLOTS.map(function (s) { return W.inv.equip[s]; })
      .filter(function (e) { return e && e.damaged; });
    if (damaged.length === 0) return { ok: false, reason: '損傷している装備が無い。' };
    var total = 0;
    for (var i = 0; i < damaged.length; i++) total += damaged[i].damaged * 40;
    if (W.inv.credits < total) return { ok: false, reason: 'クレジットが足りない。' };
    W.inv.credits -= total;
    for (var j = 0; j < damaged.length; j++) {
      damaged[j].ac += damaged[j].damaged;
      damaged[j].damaged = 0;
    }
    return { ok: true, price: total, count: damaged.length };
  }

  /* ---------- 格納庫 ---------- */

  var HOME_MAX = 24;

  function store(W, it) {
    if (W.home.length >= HOME_MAX) return { ok: false, reason: '格納庫がいっぱいだ。' };
    Inventory.remove(W.inv, it);
    W.home.push(it);
    return { ok: true };
  }

  function retrieve(W, index) {
    var it = W.home[index];
    if (!it) return { ok: false, reason: 'その品は無い。' };
    if (!Inventory.add(W.inv, it)) return { ok: false, reason: '所持品がいっぱいだ。' };
    W.home.splice(index, 1);
    return { ok: true, item: it };
  }

  return {
    SHOPS: SHOPS, MAP_W: MAP_W, MAP_H: MAP_H, HOME_MAX: HOME_MAX,
    createLevel: createLevel, shopById: shopById, shopAt: shopAt,
    restock: restock, valueOf: valueOf, unitValue: unitValue,
    buyPrice: buyPrice, sellPrice: sellPrice,
    buy: buy, sell: sell,
    analyzeService: analyzeService, cureService: cureService, repairService: repairService,
    store: store, retrieve: retrieve
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Hub;
