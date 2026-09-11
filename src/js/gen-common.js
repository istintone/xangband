/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* gen-common.js — ダンジョン生成の共通部品。DOM 非依存。
 *
 * docs/02 §2.4 の手順をそのまま実装する:
 *   1. 一様に構造材で埋める
 *   2. ブロックグリッドに分割し、各ブロックに部屋を試行配置
 *   3. 部屋の中心同士をトンネルで接続
 *   4. 階段を配置
 *   5. 連結性を検証。失敗したら生成をやり直す
 *
 * M0 では部屋タイプは「単純矩形」「内室付き」の2種のみ。
 * 柱/円形/十字/堀/区画テンプレート/Vault は M2 で足す (docs/04)。
 */
'use strict';

var Gen = (function () {

  var T = World.TILE;

  /* 生成パラメータ。サイト定義 (sites.json) で上書きできるよう外に出しておく。 */
  var DEFAULTS = {
    w: 120, h: 50,
    block: 11,            // ブロックの一辺。この中に部屋を1つ試行する
    roomChance: 0.72,     // ブロックに部屋を置く確率
    roomMin: 4, roomMax: 9,
    innerRoomChance: 0.18,// 内室付きにする確率
    doorChance: 0.25,     // 部屋の出入口を扉にする確率
    extraTunnels: 2,      // 木構造に加えて足す横道の数 (ループを作る)
    trapChance: 0.35,     // 設備障害を置く確率(1部屋あたりの期待値)
    maxAttempts: 12,      // 連結性検証に失敗したときの再試行上限
    templates: true,      // 区画テンプレート/Vault を混ぜるか

    /* --- サイト別の差 (sites.json が上書きする。docs/10 §10.5) ---
       生成アルゴリズムを書き分ける前に、まずここで到達できる差を使い切る。 */
    litRoomChance: 1.0,   // 常時照明の部屋の割合。0 なら全部暗い(遺跡)
    openness: 0,          // 壁を削って見通しを良くする度合い 0..1 (灰の地表)
    irregular: 0,         // 部屋の輪郭を崩す度合い 0..1 (異星遺跡)
    termChance: 0,        // 端末が置かれる確率 (docs/11 §11.3)
    roomPool: null        // 使う区画テンプレートの id 配列。null なら全部
  };

  /* ---------- 部屋 ---------- */

  /** 矩形を床で塗る (x1..x2, y1..y2 を含む)。 */
  function carveRect(lv, x1, y1, x2, y2, tile) {
    for (var y = y1; y <= y2; y++) {
      for (var x = x1; x <= x2; x++) World.setTile(lv, x, y, tile);
    }
  }

  /** 矩形の外周だけを塗る。内室の壁を作るのに使う。 */
  function outlineRect(lv, x1, y1, x2, y2, tile) {
    for (var x = x1; x <= x2; x++) { World.setTile(lv, x, y1, tile); World.setTile(lv, x, y2, tile); }
    for (var y = y1; y <= y2; y++) { World.setTile(lv, x1, y, tile); World.setTile(lv, x2, y, tile); }
  }

  function buildRoom(lv, rng, cfg, r) {
    carveRect(lv, r.x1, r.y1, r.x2, r.y2, T.FLOOR);

    // 内室: 部屋の中にもう一回り小さい壁を作り、1マスだけ開ける。
    // Angband の inner room の最小形。M2 で中身(宝/敵)を入れる。
    var w = r.x2 - r.x1, h = r.y2 - r.y1;
    if (w >= 6 && h >= 4 && rng.chance(cfg.innerRoomChance)) {
      var ix1 = r.x1 + 2, iy1 = r.y1 + 1, ix2 = r.x2 - 2, iy2 = r.y2 - 1;
      if (ix2 - ix1 >= 2 && iy2 - iy1 >= 1) {
        outlineRect(lv, ix1, iy1, ix2, iy2, T.WALL);
        // 開口部を1つ。四辺のどこかの中央に置く。
        var side = rng.int(4);
        var mx = (ix1 + ix2) >> 1, my = (iy1 + iy2) >> 1;
        if (side === 0) World.setTile(lv, mx, iy1, T.DOOR);
        else if (side === 1) World.setTile(lv, ix2, my, T.DOOR);
        else if (side === 2) World.setTile(lv, mx, iy2, T.DOOR);
        else World.setTile(lv, ix1, my, T.DOOR);
        r.inner = { x1: ix1, y1: iy1, x2: ix2, y2: iy2 };
      }
    }

    /* 常時照明 (docs/02 §2.2)。サイトによって割合が違う。
       遺跡は litRoomChance = 0 で、部屋に入っても何も見えない。
       ここがセル(電力)経済が最も効くサイトになる (docs/10 §10.2)。 */
    if (rng.chance(cfg.litRoomChance)) {
      for (var y = r.y1; y <= r.y2; y++) {
        for (var x = r.x1; x <= r.x2; x++) World.addFlag(lv, x, y, World.F.GLOW);
      }
      r.lit = true;
    }

    // 輪郭を崩す(異星遺跡)。矩形らしさを消して「人が作っていない」印象にする。
    if (cfg.irregular > 0) roughen(lv, rng, cfg, r);
  }

  /** 部屋の四隅と縁をランダムに削り、矩形を崩す。 */
  function roughen(lv, rng, cfg, r) {
    var w = r.x2 - r.x1 + 1, h = r.y2 - r.y1 + 1;
    if (w < 4 || h < 4) return;
    var bites = Math.round((w + h) * cfg.irregular);
    for (var i = 0; i < bites; i++) {
      // 縁のマスを1つ選んで壁に戻す。中央は残すので連結性は壊れにくい。
      var edge = rng.int(4);
      var x, y;
      if (edge === 0) { x = rng.range(r.x1, r.x2); y = r.y1; }
      else if (edge === 1) { x = rng.range(r.x1, r.x2); y = r.y2; }
      else if (edge === 2) { x = r.x1; y = rng.range(r.y1, r.y2); }
      else { x = r.x2; y = rng.range(r.y1, r.y2); }
      World.setTile(lv, x, y, T.WALL);
    }
  }

  /** ブロックグリッドに部屋を配置する。戻り値は配置できた部屋の配列。 */
  function placeRooms(lv, rng, cfg, rooms) {
    if (!rooms) rooms = [];
    var cols = Math.floor((lv.w - 2) / cfg.block);
    var rows = Math.floor((lv.h - 2) / cfg.block);

    // ブロックの巡回順をシャッフルする。左上から順だと偏りが出るため。
    var order = [];
    for (var by = 0; by < rows; by++) for (var bx = 0; bx < cols; bx++) order.push({ bx: bx, by: by });
    rng.shuffle(order);

    for (var i = 0; i < order.length; i++) {
      if (!rng.chance(cfg.roomChance)) continue;
      var ox = 1 + order[i].bx * cfg.block;
      var oy = 1 + order[i].by * cfg.block;

      var rw = rng.range(cfg.roomMin, Math.min(cfg.roomMax, cfg.block - 2));
      var rh = rng.range(cfg.roomMin - 1, Math.min(cfg.roomMax - 2, cfg.block - 2));
      var x1 = ox + rng.int(cfg.block - rw - 1);
      var y1 = oy + rng.int(cfg.block - rh - 1);
      var r = { x1: x1, y1: y1, x2: x1 + rw - 1, y2: y1 + rh - 1 };

      // マップ端に接すると外周が壊れるので 1マス余白を要求する
      if (r.x1 < 1 || r.y1 < 1 || r.x2 >= lv.w - 1 || r.y2 >= lv.h - 1) continue;

      // 既存の部屋と 1マス以上離す (壁を共有させない)
      var clash = false;
      for (var j = 0; j < rooms.length; j++) {
        if (U.rectOverlap(r, rooms[j], 1)) { clash = true; break; }
      }
      if (clash) continue;

      buildRoom(lv, rng, cfg, r);
      rooms.push(r);
    }
    return rooms;
  }

  /* ---------- 通路 ---------- */

  /**
   * (x0,y0) から (x1,y1) へ L字の通路を掘る。曲がる位置はランダム。
   * 既に床のマスはそのまま通す (部屋を貫通しない = 掘り直さない)。
   */
  function tunnel(lv, rng, cfg, x0, y0, x1, y1) {
    var horizFirst = rng.chance(0.5);
    var cx = x0, cy = y0;

    function step(nx, ny) {
      // 外周は必ず壁として残す
      if (nx < 1 || ny < 1 || nx >= lv.w - 1 || ny >= lv.h - 1) return;
      var t = World.getTile(lv, nx, ny);
      if (t === T.WALL) World.setTile(lv, nx, ny, T.FLOOR);
      cx = nx; cy = ny;
    }

    function runX(target) { while (cx !== target) step(cx + (target > cx ? 1 : -1), cy); }
    function runY(target) { while (cy !== target) step(cx, cy + (target > cy ? 1 : -1)); }

    if (horizFirst) { runX(x1); runY(y1); }
    else            { runY(y1); runX(x1); }
  }

  /** 部屋の出入口に扉を置く。通路と部屋の境目を探す。 */
  function placeDoors(lv, rng, cfg, rooms) {
    for (var i = 0; i < rooms.length; i++) {
      var r = rooms[i];
      for (var x = r.x1; x <= r.x2; x++) {
        maybeDoor(lv, rng, cfg, x, r.y1 - 1);
        maybeDoor(lv, rng, cfg, x, r.y2 + 1);
      }
      for (var y = r.y1; y <= r.y2; y++) {
        maybeDoor(lv, rng, cfg, r.x1 - 1, y);
        maybeDoor(lv, rng, cfg, r.x2 + 1, y);
      }
    }
  }

  function maybeDoor(lv, rng, cfg, x, y) {
    if (World.getTile(lv, x, y) !== T.FLOOR) return;
    if (!rng.chance(cfg.doorChance)) return;
    // 通路らしさの判定: 左右が壁 or 上下が壁 (= 幅1の場所) のときだけ扉にする
    var wl = World.blocksSight(lv, x - 1, y), wr = World.blocksSight(lv, x + 1, y);
    var wu = World.blocksSight(lv, x, y - 1), wd = World.blocksSight(lv, x, y + 1);
    if ((wl && wr && !wu && !wd) || (wu && wd && !wl && !wr)) {
      World.setTile(lv, x, y, T.DOOR);
    }
  }

  /**
   * 壁を削って開けた地形にする。周囲に床が多い壁ほど削れる。
   * 削りすぎると遮蔽物が無くなるので、孤立した壁だけを対象にする。
   */
  function openUp(lv, rng, cfg) {
    var targets = [];
    for (var y = 2; y < lv.h - 2; y++) {
      for (var x = 2; x < lv.w - 2; x++) {
        if (World.getTile(lv, x, y) !== T.WALL) continue;
        var open = 0;
        for (var d = 0; d < U.DIRS.length; d++) {
          if (World.walkable(lv, x + U.DIRS[d].dx, y + U.DIRS[d].dy)) open++;
        }
        // 周囲8マス中5つ以上が床 = ほぼ孤立した壁。これだけを削る。
        if (open >= 5) targets.push({ x: x, y: y });
      }
    }
    var n = Math.round(targets.length * cfg.openness);
    rng.shuffle(targets);
    for (var i = 0; i < n; i++) World.setTile(lv, targets[i].x, targets[i].y, T.FLOOR);
  }

  /** 設備障害を配置する。階段の上と、テンプレート区画には置かない。 */
  function placeTraps(lv, rng, cfg, rooms) {
    var n = Math.round(rooms.length * cfg.trapChance);
    for (var i = 0; i < n; i++) {
      var r = rng.pick(rooms);
      if (!r || r.template) continue;             // テンプレートは自前で配置済み
      var x = rng.range(r.x1, r.x2), y = rng.range(r.y1, r.y2);
      if (World.getTile(lv, x, y) !== T.FLOOR) continue;
      World.setTile(lv, x, y, T.TRAP);
    }
  }

  /**
   * 端末を置く (docs/11 §11.3)。1階に1つまで。
   * 階段のある部屋は避ける ―― 素通りできる場所に置くと、
   * 「寄り道して背中を晒すか」という判断が生まれない。
   */
  function placeTerminal(lv, rng, cfg, rooms) {
    if (!cfg.termChance || !rng.chance(cfg.termChance)) return null;

    var pool = rooms.filter(function (r) { return !r.vault; });
    for (var t = 0; t < 30; t++) {
      if (!pool.length) return null;
      var r = rng.pick(pool);
      var x = rng.range(r.x1, r.x2), y = rng.range(r.y1, r.y2);
      if (World.getTile(lv, x, y) !== T.FLOOR) continue;
      if (near(lv.up, x, y) || near(lv.down, x, y)) continue;
      World.setTile(lv, x, y, T.TERM);
      lv.terminal = { x: x, y: y };
      return lv.terminal;
    }
    return null;
  }

  function near(pt, x, y) {
    return !!pt && Math.abs(pt.x - x) <= 2 && Math.abs(pt.y - y) <= 2;
  }

  /* ---------- 連結性の検証 ---------- */

  /**
   * (sx,sy) から到達できる歩行可能マスを数える。
   * 戻り値 { reached, total, visited }。reached < total なら孤立部分がある。
   */
  function floodFill(lv, sx, sy) {
    var visited = new Uint8Array(lv.w * lv.h);
    var total = 0;
    for (var i = 0; i < lv.tiles.length; i++) {
      if (World.TILE_INFO[lv.tiles[i]].walk) total++;
    }
    var stack = [sy * lv.w + sx];
    visited[sy * lv.w + sx] = 1;
    var reached = 0;
    while (stack.length) {
      var p = stack.pop();
      reached++;
      var px = p % lv.w, py = (p - px) / lv.w;
      for (var d = 0; d < U.ORTHO.length; d++) {
        var nx = px + U.ORTHO[d].dx, ny = py + U.ORTHO[d].dy;
        if (!World.inBounds(lv, nx, ny)) continue;
        var n = ny * lv.w + nx;
        if (visited[n] || !World.TILE_INFO[lv.tiles[n]].walk) continue;
        visited[n] = 1;
        stack.push(n);
      }
    }
    return { reached: reached, total: total, visited: visited };
  }

  /**
   * 到達できない床を壁で埋める。
   * 埋めた結果「歩ける場所が全部繋がっている」不変条件は保たれる。
   * @returns {boolean} 埋めて通せたら true。分断が大きすぎるなら false。
   */
  function sealPockets(lv, ff, special) {
    var orphan = ff.total - ff.reached;
    // 1割を超える分断は「削り過ぎ」であって袋ではない。その階は捨てる。
    if (orphan > ff.total * 0.10) return false;

    /* テンプレート区画の配置予定地は埋められない。埋めると
       アイテムや敵が壁の中に生成される。袋に掛かっていたら階ごと捨てる。 */
    var reserved = {};
    for (var s = 0; special && s < special.length; s++) {
      for (var m = 0; m < special[s].marks.length; m++) {
        var mk = special[s].marks[m];
        reserved[mk.y * lv.w + mk.x] = 1;
      }
    }

    for (var i = 0; i < lv.tiles.length; i++) {
      if (ff.visited[i]) continue;
      if (!World.TILE_INFO[lv.tiles[i]].walk) continue;
      // 階段や配置予定地が袋の中にあるなら埋められない
      if (lv.tiles[i] === T.DOWN || lv.tiles[i] === T.UP) return false;
      if (reserved[i]) return false;
      lv.tiles[i] = T.WALL;
    }
    return true;
  }

  /* ---------- 本体 ---------- */

  /**
   * 階層を1つ生成する。
   * @param {object} rng   この階層専用のRNG (呼び出し側で derive しておく)
   * @param {number} depth 深度
   * @param {object} [opts] DEFAULTS の上書き
   * @returns {object} Level。連結性の検証を通ったものだけを返す。
   */
  function generate(rng, depth, opts) {
    var cfg = {};
    for (var k in DEFAULTS) cfg[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) cfg[k2] = opts[k2];

    for (var attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      // 試行ごとに独立したRNGを使う。失敗した試行が後続の乱数をズラさないため。
      var arng = rng.derive('gen' + attempt);
      var lv = World.createLevel(cfg.w, cfg.h);
      lv.depth = depth;

      /* 封鎖区画は**最初に**置く ([[D-81]])。
         通常部屋を先に敷き詰めると、大きな区画の入る隙間が残らない。 */
      var rooms = [];
      var special = [];
      if (cfg.templates && typeof GenRooms !== 'undefined') {
        var vault = GenRooms.placeVault(lv, arng, cfg, rooms, depth);
        if (vault) special.push(vault);
      }

      placeRooms(lv, arng, cfg, rooms);
      if (rooms.length < 3) continue;   // 部屋が少なすぎる階は捨てる

      // 区画テンプレートは通常部屋の後。空いている場所に入れる。
      // rooms に加わるので、以降のトンネル接続の対象になる = 孤立しない。
      if (cfg.templates && typeof GenRooms !== 'undefined') {
        special = special.concat(GenRooms.placeTemplates(lv, arng, cfg, rooms, depth));
      }

      // 部屋を中心のx順に並べ、隣同士を繋ぐ (交差の少ない木ができる)
      var sorted = rooms.slice().sort(function (a, b) {
        return U.rectCenter(a).x - U.rectCenter(b).x;
      });
      for (var i = 1; i < sorted.length; i++) {
        var a = U.rectCenter(sorted[i - 1]), b = U.rectCenter(sorted[i]);
        tunnel(lv, arng, cfg, a.x, a.y, b.x, b.y);
      }
      // 横道を足してループを作る。一本道だけだと逃げ場が無く、探索も単調になる。
      for (var e = 0; e < cfg.extraTunnels; e++) {
        var ra = U.rectCenter(arng.pick(rooms)), rb = U.rectCenter(arng.pick(rooms));
        if (ra.x !== rb.x || ra.y !== rb.y) tunnel(lv, arng, cfg, ra.x, ra.y, rb.x, rb.y);
      }

      // 区画テンプレートと封鎖区画。通路を掘る**前**に置くと孤立するので、
      // 部屋を置いた後・通路を掘る前に差し込み、通路接続の対象に含める。
      placeDoors(lv, arng, cfg, rooms);

      // 階段: 別々の部屋に置く。テンプレート区画(封鎖されている)は避ける。
      var stairRooms = rooms.filter(function (r) { return !r.vault; });
      if (stairRooms.length < 2) continue;
      var shuffled = arng.shuffle(stairRooms.slice());
      var upC = U.rectCenter(shuffled[0]);
      var downC = U.rectCenter(shuffled[shuffled.length - 1]);
      World.setTile(lv, upC.x, upC.y, T.UP);
      World.setTile(lv, downC.x, downC.y, T.DOWN);
      lv.up = { x: upC.x, y: upC.y };
      lv.down = { x: downC.x, y: downC.y };
      lv.rooms = rooms;

      // 連結性の検証 (docs/02 §2.4-5)。
      // 昇降機から歩行可能マス全部に届かないなら、この階は捨てる。
      var ff = floodFill(lv, lv.up.x, lv.up.y);
      if (ff.reached !== ff.total) {
        /* 輪郭を崩す生成 (異星遺跡・《起源》の irregular) は、
           削った縁の外側に小さな床の袋を残すことがある。
           階ごと捨てると 25% が無駄になるので、**袋を埋めて**通す。
           大きく分断されているときだけ、この階を諦める。 */
        if (!sealPockets(lv, ff, special)) continue;
      }

      // 開放度: 孤立した壁を削って見通しを良くする (灰の地表)。
      // 遠距離戦が主体になり、遮蔽物の陰が意味を持つ (docs/10 §10.2)。
      if (cfg.openness > 0) openUp(lv, arng, cfg);

      // 設備障害。通路と部屋にばらまく。
      placeTraps(lv, arng, cfg, rooms);

      // 端末。1階に1つまで。部屋の中に置く(通路に置くと見つけにくい)
      placeTerminal(lv, arng, cfg, rooms);

      lv.attempts = attempt;
      lv.special = special;
      lv.marks = [];
      for (var s = 0; s < special.length; s++) {
        lv.marks = lv.marks.concat(special[s].marks.map(function (m) {
          return { kind: m.kind, x: m.x, y: m.y, vault: special[s].vault, size: special[s].vaultSize };
        }));
      }
      return lv;
    }

    // ここに来るのは設計上の異常。黙って壊れた階を返すより落とす。
    throw new Error('gen: ' + cfg.maxAttempts + '回試行しても連結な階層を生成できなかった (depth=' + depth + ')');
  }

  return {
    DEFAULTS: DEFAULTS,
    generate: generate, placeTraps: placeTraps, openUp: openUp, roughen: roughen,
    placeTerminal: placeTerminal,
    sealPockets: sealPockets,
    floodFill: floodFill,
    carveRect: carveRect,
    tunnel: tunnel
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Gen;
