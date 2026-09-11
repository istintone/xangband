/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* data.js — データの索引構築と出現テーブル抽選。DOM 非依存。
 *
 * 正本は src/data/*.json。build.py がそれを data-gen.js (グローバル RAW) に変換する ([[D-25]])。
 * ここは RAW を受け取って「id で引ける形」と「深度で抽選できる形」に組み直すだけ。
 */
'use strict';

var Data = (function () {

  var db = null;

  /** 配列を id -> 要素 の Map にする。id 重複は設計ミスなので落とす。 */
  function indexById(list, what) {
    var m = {};
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e.id) throw new Error(what + '[' + i + '] に id が無い');
      if (m[e.id]) throw new Error(what + ' の id が重複: ' + e.id);
      m[e.id] = e;
    }
    return m;
  }

  function entriesOf(raw, name) {
    var o = raw[name];
    if (!o) throw new Error('データが無い: ' + name + '.json');
    return o.entries || o;
  }

  /**
   * 固定マップの中で '<' から歩いて行けない床を1つ返す。全部繋がっていれば null。
   * 手書きのマップは閉じた区画を作りやすいので、データ側で止める。
   */
  function unreachableIn(map) {
    var h = map.length, w = map[0].length;
    var sx = -1, sy = -1;
    for (var y = 0; y < h; y++) {
      var i = map[y].indexOf('<');
      if (i !== -1) { sx = i; sy = y; }
    }
    if (sx < 0) return null;                 // '<' の有無は別の検査が見る

    var seen = {};
    var stack = [[sx, sy]];
    seen[sx + ',' + sy] = 1;
    var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    while (stack.length) {
      var cur = stack.pop();
      for (var d = 0; d < DIRS.length; d++) {
        var nx = cur[0] + DIRS[d][0], ny = cur[1] + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (map[ny].charAt(nx) === '#') continue;
        var key = nx + ',' + ny;
        if (seen[key]) continue;
        seen[key] = 1;
        stack.push([nx, ny]);
      }
    }
    for (y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var ch = map[y].charAt(x);
        if (ch !== '#' && !seen[x + ',' + y]) return { x: x, y: y, ch: ch };
      }
    }
    return null;
  }

  /** RAW から索引を作る。冪等。 */
  function init(raw) {
    var monsterBase = entriesOf(raw, 'monster-base');
    var itemBase = entriesOf(raw, 'item-base');
    var monsters = entriesOf(raw, 'monsters');
    var items = entriesOf(raw, 'items');
    var lineages = entriesOf(raw, 'lineages');
    var roles = entriesOf(raw, 'roles');
    var abilities = entriesOf(raw, 'abilities');
    var sigils = entriesOf(raw, 'sigils');
    var egos = entriesOf(raw, 'egos');
    var uniques = entriesOf(raw, 'uniques');
    var rooms = entriesOf(raw, 'rooms');
    var vaults = entriesOf(raw, 'vaults');
    var sites = entriesOf(raw, 'sites');
    var origin = raw['origin'];        // entries を持たない (layers / maps)
    var fragments = entriesOf(raw, 'lore');   // ログ断片 (docs/07 §7.8)
    var netops = entriesOf(raw, 'netops');    // 電脳層の操作 (docs/11 §11.3)
    var flavors = raw['flavors'];             // 未鑑定名 (docs/02 §2.8)

    db = {
      monsterBase: indexById(monsterBase, 'monster-base'),
      itemBase: indexById(itemBase, 'item-base'),
      monsters: monsters, monstersById: indexById(monsters, 'monsters'),
      items: items, itemsById: indexById(items, 'items'),
      lineages: lineages, lineagesById: indexById(lineages, 'lineages'),
      roles: roles, rolesById: indexById(roles, 'roles'),
      abilities: abilities, abilitiesById: indexById(abilities, 'abilities'),
      sigils: sigils, sigilsById: indexById(sigils, 'sigils'),
      egos: egos, egosById: indexById(egos, 'egos'),
      uniques: uniques, uniquesById: indexById(uniques, 'uniques'),
      rooms: rooms, roomsById: indexById(rooms, 'rooms'),
      vaults: vaults, vaultsById: indexById(vaults, 'vaults'),
      sites: sites, sitesById: indexById(sites, 'sites'),
      origin: origin,
      fragments: fragments, fragmentsById: indexById(fragments, 'lore'),
      netops: netops, netopsById: indexById(netops, 'netops'),
      flavors: flavors
    };

    validate(db);
    return db;
  }

  /**
   * 参照の健全性を検証する。壊れたデータで走り出すより早く落とす。
   * ここを通れば「未知の id を引いて undefined」が実行時に起きない。
   */
  function validate(db) {
    var i, j;
    function need(map, id, what) {
      if (!map[id]) throw new Error(what + ': 未知の id "' + id + '"');
    }

    for (i = 0; i < db.monsters.length; i++) {
      var m = db.monsters[i];
      need(db.monsterBase, m.base, 'monsters/' + m.id + ' の base');
      if (m.escort) need(db.monstersById, m.escort, 'monsters/' + m.id + ' の escort');
    }
    for (i = 0; i < db.items.length; i++) {
      need(db.itemBase, db.items[i].base, 'items/' + db.items[i].id + ' の base');
    }
    for (i = 0; i < db.roles.length; i++) {
      var r = db.roles[i];
      for (j = 0; j < (r.abilities || []).length; j++) {
        need(db.abilitiesById, r.abilities[j], 'roles/' + r.id + ' の ability');
      }
    }
    for (i = 0; i < db.egos.length; i++) {
      var e = db.egos[i];
      for (j = 0; j < (e.sigils || []).length; j++) need(db.sigilsById, e.sigils[j], 'egos/' + e.id);
      for (j = 0; j < (e.taint || []).length; j++) need(db.sigilsById, e.taint[j], 'egos/' + e.id + ' の taint');
      for (j = 0; j < (e.bases || []).length; j++) need(db.itemBase, e.bases[j], 'egos/' + e.id + ' の base');
    }
    for (i = 0; i < db.sites.length; i++) {
      var st = db.sites[i];
      for (j = 0; j < (st.rooms || []).length; j++) {
        need(db.roomsById, st.rooms[j], 'sites/' + st.id + ' の room');
      }
      for (var b in (st.weight || {})) need(db.monsterBase, b, 'sites/' + st.id + ' の weight');
      if (st.depthMin > st.depthMax) throw new Error('sites/' + st.id + ': 深度レンジが逆');
    }

    /* 《起源》の固定マップ (docs/07 §7.4)。
       昇降機の無い階を作ると、入った瞬間に戻れなくなる。 */
    if (db.origin) {
      for (i = 0; i < db.origin.maps.length; i++) {
        var fx = db.origin.maps[i];
        var joined = fx.map.join('');
        if (joined.indexOf('<') === -1) {
          throw new Error('origin/' + fx.id + ': 昇降機(<)が無い');
        }
        var wid = fx.map[0].length;
        for (var r = 0; r < fx.map.length; r++) {
          if (fx.map[r].length !== wid) {
            throw new Error('origin/' + fx.id + ': ' + r + '行目の幅が違う');
          }
        }
        /* 手で書いたマップは、閉じた区画を作りやすい。
           実際《起源》の中央のボス区画が壁で塞がっていた。
           **床は全部 < から歩いて行けること**を強制する。 */
        var unreached = unreachableIn(fx.map);
        if (unreached) {
          throw new Error('origin/' + fx.id + ': 到達できない床がある (' +
                          unreached.x + ',' + unreached.y + ' = ' + unreached.ch + ')');
        }
      }
    }
    /* 未鑑定名(フレーバー)の在庫が品目数に足りているか。
       足りないと2種類が同じ見た目になり、**別物を同じものだと学習してしまう**。
       アイテムを足したときに黙って壊れる箇所なので、ここで止める。 */
    if (db.flavors) {
      var byBase = {};
      for (i = 0; i < db.items.length; i++) {
        var ib = db.itemBase[db.items[i].base];
        if (ib && ib.flavored !== false && db.flavors[db.items[i].base]) {
          byBase[db.items[i].base] = (byBase[db.items[i].base] || 0) + 1;
        }
      }
      for (var fb in byBase) {
        if (db.flavors[fb].length < byBase[fb]) {
          throw new Error('flavors/' + fb + ': 未鑑定名が ' + db.flavors[fb].length +
                          ' 種しかないのに品目が ' + byBase[fb] + ' 種ある');
        }
      }
    }

    for (i = 0; i < db.uniques.length; i++) {
      var u = db.uniques[i];
      need(db.itemsById, u.base, 'uniques/' + u.id + ' の base');
      for (j = 0; j < (u.sigils || []).length; j++) need(db.sigilsById, u.sigils[j], 'uniques/' + u.id);
      for (j = 0; j < (u.taint || []).length; j++) need(db.sigilsById, u.taint[j], 'uniques/' + u.id + ' の taint');
    }
  }

  function get() {
    if (!db) throw new Error('Data.init(RAW) が呼ばれていない');
    return db;
  }

  /* ---------- 出現テーブル (docs/02 §2.3) ---------- */

  /* OOD (深度外生成) のパラメータ。本家の ood_monster_chance / GREAT_OBJ 相当。 */
  var OOD = {
    monsterChance: 25,   // 1/25
    monsterCap: 10,
    itemChance: 20       // 1/20
  };

  /** 敵の抽選深度を決める。稀に深いものを引き当てる。 */
  function boostMonsterDepth(rng, depth) {
    if (depth > 0 && rng.oneIn(OOD.monsterChance)) {
      return depth + Math.min(Math.floor(depth / 4) + 2, OOD.monsterCap);
    }
    return depth;
  }

  /** アイテムの抽選深度。分母に小さい値を引くと押し上げが跳ねる (本家の形)。 */
  function boostItemDepth(rng, depth) {
    if (depth > 0 && rng.oneIn(OOD.itemChance)) {
      return Math.min(100, 1 + Math.floor(depth * 100 / rng.range(1, 100)));
    }
    return depth;
  }

  /**
   * depth 以下のエントリから重み 1/rarity で1つ選ぶ。
   * 候補が無ければ深度を1ずつ下げて探す (深度1でも見つからなければ null)。
   */
  /**
   * 深度から離れたものほど出にくくする。本家 `alloc_max` に相当する働き ([[D-77]])。
   *
   * 重みが 1/rarity だけだと、**深度90 の階に深度1 の敵とバールが同じ確率で出る**。
   * 候補が増えるほど薄まるとはいえ、深部が「浅い物の詰め合わせ」になる。
   * 完全に切ると本家の「たまに雑魚が混じる」質感が消えるので、緩やかに減衰させる。
   *
   * @param slack これ以内の差なら減衰しない深度差 (`window` はブラウザの
   *              グローバルを覆うので使わない ―― K-2 が正しく咎めた)
   */
  function depthWeight(entry, d, slack) {
    var w = 1 / (entry.rarity || 1);
    /* 品目ごとの猶予。携行食とセルは深部でも要るので歳を取らない。
       装備は歳を取る ―― でないと深度90 の床にバールが落ち続ける。 */
    var lim = entrySpan(entry, slack);
    var span = d - entry.depth;
    if (span <= lim) return w;
    /* 二乗で落とす。線形だと「浅い品目のほうが数が多い」ぶんを押し切れず、
       深度90 の床の半分が深度1 の装備のままだった。 */
    var k = lim / span;
    return w * k * k;
  }

  function entrySpan(entry, fallback) {
    if (entry.span !== undefined) return entry.span;
    if (entry.base && db && db.itemBase[entry.base] &&
        db.itemBase[entry.base].span !== undefined) {
      return db.itemBase[entry.base].span;
    }
    return fallback;
  }

  var MON_WINDOW = 25;    // 敵は雑魚が混じる余地を残す
  var ITEM_WINDOW = 12;   // 品物は「今の深さに見合うもの」が出るべき

  function allocate(rng, list, depth, slack) {
    if (slack === undefined) slack = MON_WINDOW;
    for (var d = depth; d >= 0; d--) {
      var total = 0, i;
      for (i = 0; i < list.length; i++) {
        if (list[i].depth <= d) total += depthWeight(list[i], d, slack);
      }
      if (total <= 0) continue;

      // 重みは分数なので、整数乱数を使うために 1000 倍して丸める
      var roll = rng.int(Math.max(1, Math.round(total * 1000)));
      var acc = 0;
      for (i = 0; i < list.length; i++) {
        if (list[i].depth > d) continue;
        acc += Math.round(depthWeight(list[i], d, slack) * 1000);
        if (roll < acc) return list[i];
      }
      // 丸め誤差で溢れた場合は最後の候補
      for (i = list.length - 1; i >= 0; i--) if (list[i].depth <= d) return list[i];
    }
    return null;
  }

  function pickMonster(rng, depth) {
    return allocate(rng, get().monsters, boostMonsterDepth(rng, depth));
  }

  function pickItem(rng, depth) {
    return allocate(rng, get().items, boostItemDepth(rng, depth), ITEM_WINDOW);
  }

  /** "3d5" / "2d4+1" / "7" を数値に振る。 */
  function rollDice(rng, spec) {
    if (typeof spec === 'number') return spec;
    var m = /^(\d+)d(\d+)(?:\+(\d+))?$/.exec(String(spec).trim());
    if (!m) {
      var n = parseInt(spec, 10);
      if (isNaN(n)) throw new Error('ダイス表記が不正: ' + spec);
      return n;
    }
    return rng.dice(parseInt(m[1], 10), parseInt(m[2], 10)) + (m[3] ? parseInt(m[3], 10) : 0);
  }

  /** ダイスの平均値 (バランス検証・表示用。乱数を使わない)。 */
  function diceAvg(spec) {
    if (typeof spec === 'number') return spec;
    var m = /^(\d+)d(\d+)(?:\+(\d+))?$/.exec(String(spec).trim());
    if (!m) return parseInt(spec, 10) || 0;
    var n = parseInt(m[1], 10), s = parseInt(m[2], 10);
    return n * (s + 1) / 2 + (m[3] ? parseInt(m[3], 10) : 0);
  }

  return {
    init: init, get: get, validate: validate,
    OOD: OOD,
    allocate: allocate, depthWeight: depthWeight, entrySpan: entrySpan,
    MON_WINDOW: MON_WINDOW, ITEM_WINDOW: ITEM_WINDOW,
    boostMonsterDepth: boostMonsterDepth, boostItemDepth: boostItemDepth,
    pickMonster: pickMonster, pickItem: pickItem,
    rollDice: rollDice, diceAvg: diceAvg
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Data;
