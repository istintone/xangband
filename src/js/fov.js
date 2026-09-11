/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* fov.js — 視界。再帰シャドウキャスティング (8オクタント)。DOM 非依存。
 *
 * docs/02 §2.2 の要件:
 *   - 対称性を確保する (A から B が見えるなら B から A も見える)
 *   - 光源半径ぶんだけ照らす
 *   - 常時照明区画(GLOW)の部屋は、入室すると部屋全体が見える
 *   - 一度見た地形は記憶する (KNOWN)。敵とアイテムは記憶しない
 */
'use strict';

var FOV = (function () {

  /* オクタントごとの座標変換。(row, col) -> (dx, dy)
     8方向を1つの再帰関数で扱うための定石。 */
  var OCTANTS = [
    { xx:  1, xy:  0, yx:  0, yy:  1 },
    { xx:  0, xy:  1, yx:  1, yy:  0 },
    { xx:  0, xy: -1, yx:  1, yy:  0 },
    { xx: -1, xy:  0, yx:  0, yy:  1 },
    { xx: -1, xy:  0, yx:  0, yy: -1 },
    { xx:  0, xy: -1, yx: -1, yy:  0 },
    { xx:  0, xy:  1, yx: -1, yy:  0 },
    { xx:  1, xy:  0, yx:  0, yy: -1 }
  ];

  /**
   * 1オクタントを走査する。
   * @param start,end 可視の傾き範囲 (start >= end)
   */
  function castOctant(lv, ox, oy, radius, row, start, end, oct, mark) {
    if (start < end) return;

    var blocked = false;
    var newStart = start;

    for (var i = row; i <= radius && !blocked; i++) {
      var dy = -i;
      for (var dx = -i; dx <= 0; dx++) {
        var lSlope = (dx - 0.5) / (dy + 0.5);
        var rSlope = (dx + 0.5) / (dy - 0.5);
        if (start < rSlope) continue;
        if (end > lSlope) break;

        var mx = ox + dx * oct.xx + dy * oct.xy;
        var my = oy + dx * oct.yx + dy * oct.yy;
        if (!World.inBounds(lv, mx, my)) continue;

        // チェビシェフではなく円形にする。四隅だけ見えるのは不自然なため。
        if (dx * dx + dy * dy <= radius * radius + radius) mark(mx, my);

        var wall = World.blocksSight(lv, mx, my);
        if (blocked) {
          if (wall) { newStart = rSlope; continue; }
          blocked = false;
          start = newStart;
        } else if (wall && i < radius) {
          blocked = true;
          castOctant(lv, ox, oy, radius, i + 1, start, lSlope, oct, mark);
          newStart = rSlope;
        }
      }
    }
  }

  /**
   * (ox,oy) を中心に半径 radius の視界を計算し、VISIBLE と KNOWN を立てる。
   * 直前の VISIBLE は消す (今見えているものだけが VISIBLE)。
   */
  function compute(lv, ox, oy, radius) {
    World.clearFlagAll(lv, World.F.VISIBLE);

    /* シャドウキャスティングは角で稀に非対称になる(このアルゴリズムの既知の性質)。
       **視線の正本は lineOfSight** にして、シャドウキャスティングは
       「候補を速く絞る」役だけにする。
       こうするとプレイヤーの視界と敵の視線が同じ定義になり、
       「こちらからは見えるが向こうからは見えない」が起きない ([[D-29]])。 */
    function mark(x, y) {
      if (x !== ox || y !== oy) {
        if (!lineOfSight(lv, ox, oy, x, y)) return;
      }
      World.addFlag(lv, x, y, World.F.VISIBLE | World.F.KNOWN);
    }
    mark(ox, oy);
    for (var i = 0; i < OCTANTS.length; i++) {
      castOctant(lv, ox, oy, radius, 1, 1.0, 0.0, OCTANTS[i], mark);
    }

    // 常時照明区画: 立っている部屋の中なら、部屋全体を見えたことにする。
    // Angband の「明るい部屋に入ると全体が見える」挙動 (docs/02 §2.2)。
    if (World.hasFlag(lv, ox, oy, World.F.GLOW)) {
      var room = roomAt(lv, ox, oy);
      if (room) {
        for (var y = room.y1 - 1; y <= room.y2 + 1; y++) {
          for (var x = room.x1 - 1; x <= room.x2 + 1; x++) {
            if (World.inBounds(lv, x, y)) mark(x, y);
          }
        }
      }
    }
  }

  /** (x,y) を含む部屋を返す。内室の中に居る場合は内室を優先する。 */
  function roomAt(lv, x, y) {
    for (var i = 0; i < lv.rooms.length; i++) {
      var r = lv.rooms[i];
      if (x >= r.x1 && x <= r.x2 && y >= r.y1 && y <= r.y2) {
        if (r.inner && x > r.inner.x1 && x < r.inner.x2 && y > r.inner.y1 && y < r.inner.y2) {
          return r.inner;
        }
        return r;
      }
    }
    return null;
  }

  /**
   * 2点間に視線が通るか。Bresenham で両方向から引き、
   * どちらかが通れば可視とする(対称性の確保 — [[D-29]])。
   * compute() のフラグを汚さないので、敵の索敵から安全に呼べる。
   */
  function lineOfSight(lv, x0, y0, x1, y1) {
    return traceClear(lv, x0, y0, x1, y1) || traceClear(lv, x1, y1, x0, y0);
  }

  function traceClear(lv, x0, y0, x1, y1) {
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    var err = dx - dy;
    var x = x0, y = y0;

    for (var guard = 0; guard < 1000; guard++) {
      if (x === x1 && y === y1) return true;
      // 始点は自分自身なので判定しない。終点は上の行で先に返る。
      if (!(x === x0 && y === y0) && World.blocksSight(lv, x, y)) return false;
      var e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x += sx; }
      if (e2 < dx) { err += dx; y += sy; }
    }
    return false;
  }

  return { compute: compute, roomAt: roomAt, lineOfSight: lineOfSight };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FOV;
