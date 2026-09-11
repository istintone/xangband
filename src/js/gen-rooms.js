/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* gen-rooms.js — 区画テンプレートと封鎖区画(Vault)。docs/02 §2.4。DOM 非依存。
 *
 * 文字列マップを地形に貼り付ける。中身(敵・アイテム)は
 * 「どこに置くか」だけを記録し、実際の生成は階層の配置段階で行う
 * (生成器は敵・アイテムのモジュールに依存しない = テストしやすい)。
 */
'use strict';

var GenRooms = (function () {

  var T = World.TILE;

  /* 記号 -> 地形。中身の記号は床にして、座標を marks に積む。 */
  var GLYPH = {
    '#': { tile: T.WALL },
    '.': { tile: T.FLOOR, glow: true },
    ',': { tile: T.FLOOR, glow: false },   // 照明なしの床
    '+': { tile: T.DOOR, glow: true },
    '^': { tile: T.TRAP, glow: true },
    '*': { tile: T.FLOOR, glow: true, mark: 'item' },
    '&': { tile: T.FLOOR, glow: true, mark: 'goodItem' },
    '9': { tile: T.FLOOR, glow: true, mark: 'monster' },
    '8': { tile: T.FLOOR, glow: true, mark: 'toughMonster' },
    '%': { tile: T.WALL }
  };

  function size(tpl) {
    var h = tpl.map.length;
    var w = 0;
    for (var i = 0; i < h; i++) w = Math.max(w, tpl.map[i].length);
    return { w: w, h: h };
  }

  /**
   * (x1,y1) を左上としてテンプレートを貼れるか。
   * 既存の部屋と重ならず、マップ端から1マス以上離れていること。
   */
  function fits(lv, rooms, x1, y1, w, h) {
    if (x1 < 1 || y1 < 1 || x1 + w >= lv.w - 1 || y1 + h >= lv.h - 1) return false;
    var r = { x1: x1, y1: y1, x2: x1 + w - 1, y2: y1 + h - 1 };
    for (var i = 0; i < rooms.length; i++) {
      if (U.rectOverlap(r, rooms[i], 1)) return false;
    }
    return true;
  }

  /**
   * テンプレートを貼る。
   * @returns {object} { x1,y1,x2,y2, marks: [{kind,x,y}], template: id }
   */
  function paste(lv, tpl, x1, y1, lit) {
    var s = size(tpl);
    var marks = [];
    if (lit === undefined) lit = true;
    for (var y = 0; y < s.h; y++) {
      var row = tpl.map[y];
      for (var x = 0; x < row.length; x++) {
        var g = GLYPH[row[x]];
        if (!g) continue;
        var mx = x1 + x, my = y1 + y;
        World.setTile(lv, mx, my, g.tile);
        // 照明はサイトの設定に従う。暗いサイトではテンプレートも暗い。
        if (g.glow && lit) World.addFlag(lv, mx, my, World.F.GLOW);
        if (g.mark) marks.push({ kind: g.mark, x: mx, y: my });
      }
    }
    return {
      x1: x1, y1: y1, x2: x1 + s.w - 1, y2: y1 + s.h - 1,
      marks: marks, template: tpl.id, vault: !!tpl.size, vaultSize: tpl.size || null
    };
  }

  /**
   * ブロックグリッドの上に、テンプレート区画を試行配置する。
   * 通常の部屋を置いた**後**に呼ぶ (空いている場所に入れる)。
   */
  function placeTemplates(lv, rng, cfg, rooms, depth) {
    var db = Data.get();
    var placed = [];

    /* サイトが好む区画テンプレートだけを候補にする (docs/10 §10.5)。
       医療ベイは方舟、炉心区画は遺跡 ― データだけで場所の性格が変わる。 */
    var pool = db.rooms;
    if (cfg.roomPool && cfg.roomPool.length) {
      var filtered = db.rooms.filter(function (t) { return cfg.roomPool.indexOf(t.id) !== -1; });
      if (filtered.length) pool = filtered;
    }

    // 区画テンプレート: 深度に応じて 0〜2 個
    var nTemplates = rng.int(3);
    for (var i = 0; i < nTemplates; i++) {
      var tpl = Data.allocate(rng, pool, depth);
      if (!tpl) break;
      var r = tryPlace(lv, rng, rooms, tpl, rng.chance(cfg.litRoomChance));
      if (r) { rooms.push(r); placed.push(r); }
    }

    return placed;
  }

  /**
   * 封鎖区画(Vault)。稀。大きいほど稀。
   * 出た階は危険度と有望度が同時に跳ね上がる。
   *
   * **通常部屋より先に置く** ([[D-81]])。後から置くと、密な生成器
   * (遺跡 block 9 / 尖塔 roomChance 0.85 / 《起源》) では大きな区画の
   * 入る隙間が残らず、実測で 0〜1/60 しか出ていなかった ―― 機能が存在しないに等しい。
   *
   * @returns {object|null} 置けた区画
   */
  function placeVault(lv, rng, cfg, rooms, depth) {
    if (!rng.oneIn(12)) return null;
    var db = Data.get();
    var pool = db.vaults.filter(function (v) {
      return v.depth <= depth && (v.size === 'small' || depth >= 18);
    });
    if (!pool.length) return null;
    var v = Data.allocate(rng, pool, depth, Data.ITEM_WINDOW);
    if (!v) return null;
    var r = tryPlace(lv, rng, rooms, v, rng.chance(cfg.litRoomChance));
    if (r) rooms.push(r);
    return r;
  }

  function tryPlace(lv, rng, rooms, tpl, lit) {
    var s = size(tpl);
    for (var attempt = 0; attempt < 60; attempt++) {
      var x1 = rng.range(1, Math.max(1, lv.w - s.w - 2));
      var y1 = rng.range(1, Math.max(1, lv.h - s.h - 2));
      if (!fits(lv, rooms, x1, y1, s.w, s.h)) continue;
      return paste(lv, tpl, x1, y1, lit);
    }
    return null;
  }

  return {
    GLYPH: GLYPH, size: size, fits: fits, paste: paste,
    placeTemplates: placeTemplates, placeVault: placeVault, tryPlace: tryPlace
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GenRooms;
