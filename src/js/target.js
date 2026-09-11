/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* target.js — 注視と目標指定。docs/09 §9.4 ([[D-49]])。DOM 非依存。
 *
 * M2 の最大の穴: 遠隔攻撃と能力を実装したのに「どれを狙うか」が
 * プレイヤーの手に無かった。群れの中の1体を狙う選択が成立していなかった。
 *
 * ルール層に置くので、目標選択のロジックもヘッドレスでテストできる。
 */
'use strict';

var Target = (function () {

  /** 注視モードの状態。W に持たせる(セーブ対象外の一時状態)。 */
  function createCursor(W) {
    return { x: W.player.x, y: W.player.y, index: -1 };
  }

  /**
   * 注視の対象になりうるものを近い順に並べる。
   * 見えている敵 → 見えているアイテム → の順。
   */
  function candidates(W) {
    var p = W.player, lv = W.level, out = [];
    var i;

    for (i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (!World.hasFlag(lv, a.x, a.y, World.F.VISIBLE) && !a.detected) continue;
      out.push({ kind: 'monster', actor: a, x: a.x, y: a.y,
                 dist: U.distCheb(a.x, a.y, p.x, p.y) });
    }
    for (i = 0; i < W.items.length; i++) {
      var it = W.items[i];
      if (!World.hasFlag(lv, it.x, it.y, World.F.VISIBLE)) continue;
      out.push({ kind: 'item', item: it, x: it.x, y: it.y,
                 dist: U.distCheb(it.x, it.y, p.x, p.y) });
    }

    // 敵を先に、それぞれ近い順。同距離なら座標順(決定論を保つ)。
    out.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'monster' ? -1 : 1;
      if (a.dist !== b.dist) return a.dist - b.dist;
      return (a.y - b.y) || (a.x - b.x);
    });
    return out;
  }

  /** 次の候補へカーソルを送る。候補が無ければ null。 */
  function cycle(W, cursor, dir) {
    var list = candidates(W);
    if (list.length === 0) return null;
    var n = list.length;
    cursor.index = ((cursor.index + (dir || 1)) % n + n) % n;
    var c = list[cursor.index];
    cursor.x = c.x; cursor.y = c.y;
    return c;
  }

  /** カーソルを自由に動かす。マップ内に留める。 */
  function move(W, cursor, dx, dy) {
    var lv = W.level;
    cursor.x = U.clamp(cursor.x + dx, 0, lv.w - 1);
    cursor.y = U.clamp(cursor.y + dy, 0, lv.h - 1);
    cursor.index = -1;          // 自由移動したら候補の巡回から外れる
    return at(W, cursor.x, cursor.y);
  }

  /** その座標にあるものを返す。 */
  function at(W, x, y) {
    var a = World.actorAt(W, x, y);
    if (a && a.kind !== 'player' &&
        (World.hasFlag(W.level, x, y, World.F.VISIBLE) || a.detected)) {
      return { kind: 'monster', actor: a, x: x, y: y };
    }
    var items = Item.itemsAt(W, x, y);
    if (items.length && World.hasFlag(W.level, x, y, World.F.KNOWN)) {
      return { kind: 'item', item: items[0], x: x, y: y };
    }
    if (World.hasFlag(W.level, x, y, World.F.KNOWN)) {
      return { kind: 'tile', tile: World.getTile(W.level, x, y), x: x, y: y };
    }
    return { kind: 'unknown', x: x, y: y };
  }

  /* ---------- 目標の記憶 ---------- */

  /**
   * 目標を設定する。以後 f(撃つ) と m(能力) がこれを使う。
   * @param what candidates() / at() が返した対象
   */
  function set(W, what) {
    if (!what || what.kind !== 'monster') { W.target = null; return false; }
    W.target = { id: what.actor.id };
    return true;
  }

  function clear(W) { W.target = null; }

  /**
   * 記憶した目標を解決する。
   * 死んだ / 見えなくなった / 階が変わった 場合は自動で解除する。
   */
  function resolve(W) {
    if (!W.target) return null;
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.id !== W.target.id) continue;
      if (a.dead) break;
      if (!World.hasFlag(W.level, a.x, a.y, World.F.VISIBLE) && !a.detected) break;
      return a;
    }
    W.target = null;
    return null;
  }

  /**
   * 攻撃/能力が狙う相手。目標が有効ならそれ、無ければ最も近い敵。
   * これで「目標を指定しなければ従来通り」が保たれる。
   */
  function pick(W) {
    return resolve(W) || Effect.nearestVisible(W, W.player);
  }

  /* ---------- 説明文 ---------- */

  /** カーソル下のものの説明。知っていることだけを出す。 */
  function describe(W, what) {
    if (!what) return ['(何もない)'];
    if (what.kind === 'monster') {
      var a = what.actor;
      var lines = [a.name];
      var e = W.lore[a.raceId];
      lines.push('  距離 ' + U.distCheb(a.x, a.y, W.player.x, W.player.y) +
                 (a.asleep > 0 ? '  眠っている' : ''));
      if (e && Lore.knowsHP(W, a.raceId)) {
        lines.push('  体力 およそ ' + Math.round(a.hpMax) + '  防御 ' + a.ac);
        lines.push('  速度 ' + Turn.speedLabel(a.speed));
      } else {
        lines.push('  体力 不明');
      }
      var ratio = a.hp / a.hpMax;
      lines.push('  ' + (ratio > 0.75 ? '無傷' : ratio > 0.4 ? '傷ついている' :
                         ratio > 0.15 ? '深手を負っている' : '瀕死'));
      return lines;
    }
    if (what.kind === 'item') {
      return [Inventory.label(what.item, W.knowledge)];
    }
    if (what.kind === 'tile') {
      return [World.TILE_INFO[what.tile].name];
    }
    return ['(未探索)'];
  }

  return {
    createCursor: createCursor, candidates: candidates,
    cycle: cycle, move: move, at: at,
    set: set, clear: clear, resolve: resolve, pick: pick,
    describe: describe
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Target;
