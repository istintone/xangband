/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* action.js — 文脈アクション。docs/09 §9.18 ([[D-85]])。DOM 非依存。
 *
 * 「今ここでできること」を組み立てる。
 *
 * コマンドが25個あることが問題なのではない。
 * **どの瞬間でも意味があるのは3〜6個**で、それが画面に出ていないことが問題だった。
 *
 * ここが出すのは**実行できるコマンドそのもの**で、キー入力と同じ経路を通る ([[D-57]])。
 * 各行にキーを併記するのは、一覧を松葉杖ではなく**教材**にするため ――
 * 使ううちにキーを覚えて、一覧を開かなくなるのが正しい姿。
 */
'use strict';

var Action = (function () {

  var MAX = 7;          // 全部載せると「今できること」でなくなる

  /* 並び順 = 優先度。危険なものが先頭に来る。 */
  var RANK = { danger: 0, warn: 1, tip: 2, info: 3 };

  function add(out, level, key, label, why, cmd) {
    out.push({ level: level, key: key, label: label, why: why, cmd: cmd });
  }

  /**
   * 今できることの一覧。
   * @returns {Array} { level, key, label, why, cmd }
   */
  function list(W) {
    var out = [];
    if (!W || !W.player || W.dead) return out;
    var p = W.player, lv = W.level;

    if (W.depth === 0) { hub(W, out); return trim(out); }

    danger(W, out);
    underfoot(W, out);
    adjacent(W, out);
    ranged(W, out);
    upkeepish(W, out);

    return trim(out);
  }

  function trim(out) {
    out.sort(function (a, b) { return RANK[a.level] - RANK[b.level]; });
    /* 同じ行動が二度出ないようにする。
       「気密が足りない→戻る」と「昇降機の上→戻る」が同時に立つ。
       先に来たほう(=優先度が高いほう)の理由を残す。 */
    var seen = {}, uniq = [];
    for (var i = 0; i < out.length && uniq.length < MAX; i++) {
      var key = out[i].key + '/' + out[i].label;
      if (seen[key]) continue;
      seen[key] = 1;
      uniq.push(out[i]);
    }
    return uniq;
  }

  /* ---------- 生死に関わるもの。必ず先頭に来る ---------- */

  function danger(W, out) {
    var p = W.player;

    if (Env.sealDeficit(W) > 0) {
      add(out, 'danger', '<', '戻る', '気密が足りない。ここには居られない',
          { type: 'ascend' });
    }
    if (p.hp * 3 < p.hpMax) {
      var heal = firstItem(W, function (it) { return usableKnown(W, it, 'heal'); });
      if (heal) {
        add(out, 'danger', 'u', '回復する', Sigil.name(W.knowledge, heal) + 'を使う',
            { type: 'use', item: heal });
      } else {
        add(out, 'danger', '<', '戻る', 'HP が危険。回復する物が無い', { type: 'ascend' });
      }
    }
    if (p.food < 300) {
      var food = firstItem(W, function (it) { return usableKnown(W, it, 'feed'); });
      if (food) {
        add(out, 'danger', 'u', '食べる', '衰弱しかけている', { type: 'use', item: food });
      }
    }
  }

  /* ---------- 足元 ---------- */

  function underfoot(W, out) {
    var p = W.player, lv = W.level;
    var tile = World.getTile(lv, p.x, p.y);

    if (tile === World.TILE.DOWN) {
      add(out, 'tip', '>', '降りる', 'この下へ続いている', { type: 'descend' });
    }
    if (tile === World.TILE.UP) {
      add(out, 'info', '<', '戻る', '一つ上の階へ', { type: 'ascend' });
    }
    if (tile === World.TILE.TERM) {
      add(out, 'tip', 'J', '接続する',
          '認知 ' + p.cog + '/' + p.cogMax + ' を払って階に干渉する',
          { type: 'menu', mode: 'net' });
    }

    var here = Item.itemsAt(W, p.x, p.y);
    if (here.length) {
      var it = here[0];
      if (Fragment.isFragment(it)) {
        add(out, 'tip', 'g', '読む', it.name + 'が落ちている', { type: 'pickup' });
      } else {
        add(out, 'tip', 'g', '拾う', Sigil.name(W.knowledge, it) + 'が落ちている',
            { type: 'pickup' });
      }
    }
  }

  /* ---------- 隣接 ---------- */

  function adjacent(W, out) {
    var p = W.player;
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (U.distCheb(a.x, a.y, p.x, p.y) !== 1) continue;
      add(out, 'warn', '方向', a.name + 'を殴る',
          a.asleep > 0 ? '眠っている。不意打ちになる' : '隣にいる',
          { type: 'move', dx: Math.sign(a.x - p.x), dy: Math.sign(a.y - p.y) });
      return;                                  // 1体で足りる。列挙しない
    }
  }

  /* ---------- 視界内 ---------- */

  function ranged(W, out) {
    var p = W.player;
    var foe = Cmd.visibleFoe(W);
    if (!foe) return;

    if (W.inv.equip.launcher) {
      add(out, 'tip', 'f', '撃つ', foe.name + 'が見えている', { type: 'shoot' });
    }
    if (p.system && p.abilities.length && p.sp > 0) {
      add(out, 'tip', 'm', '能力を使う', Ability.SYSTEM_NAME[p.system] + ' ' + p.sp + '/' + p.spMax,
          { type: 'menu', mode: 'ability' });
    }
    if (!W.target) {
      add(out, 'info', 'x', '目標を選ぶ', '狙う相手を決めておく', { type: 'look' });
    }
  }

  /* ---------- 状態 ---------- */

  function upkeepish(W, out) {
    var p = W.player;

    if (W.inv.items.length >= Inventory.MAX_ITEMS) {
      add(out, 'warn', 'd', '置く', '所持品がいっぱい', { type: 'menu', mode: 'drop' });
    }
    if (p.system && Ability.canLearnMore(p) && Ability.learnable(p).length) {
      add(out, 'tip', 'm', '能力を習得', '習得できる能力がある',
          { type: 'menu', mode: 'ability' });
    }
    // 装備していない装備品を持っている
    var wear = firstItem(W, function (it) {
      return it.slot && !W.inv.equip[it.slot];
    });
    if (wear) {
      add(out, 'tip', 'w', '装備する', Sigil.name(W.knowledge, wear) + 'が空きスロットに入る',
          { type: 'equip', item: wear });
    }
    if (!Cmd.visibleFoe(W) && p.hp < p.hpMax) {
      add(out, 'info', 'R', '休息', '敵は見えていない。HP が戻る', { type: 'rest' });
    }
  }

  /* ---------- 母船 ---------- */

  function hub(W, out) {
    var p = W.player;
    var shop = Hub.shopAt(W.level, p.x, p.y);
    if (shop) {
      add(out, 'tip', 'Enter', '区画に入る',
          (Hub.shopById(shop) || { name: '格納庫' }).name, { type: 'enter' });
    }
    if (World.getTile(W.level, p.x, p.y) === World.TILE.DOWN) {
      add(out, 'tip', '>', '降りる',
          (W.site ? W.site.name : '') + ' 深度 ' + Cmd.resumeDepth(W) + ' へ',
          { type: 'descend' });
    } else if (W.level.down) {
      // 母船で最も使う行動なので、足元でなくても道筋を示す
      var d = U.distCheb(p.x, p.y, W.level.down.x, W.level.down.y);
      add(out, 'tip', '方向', '降下ポッドへ',
          d + ' マス先。その上で > を押す',
          { type: 'move',
            dx: U.clamp(W.level.down.x - p.x, -1, 1),
            dy: U.clamp(W.level.down.y - p.y, -1, 1) });
    }
    add(out, 'info', 'V', '降下先を選ぶ', '母船でしか変えられない',
        { type: 'menu', mode: 'site' });
    add(out, 'info', 'i', '所持品', '持ち物を確かめる', { type: 'menu', mode: 'inventory' });
    return out;
  }

  /* ---------- 補助 ---------- */

  function firstItem(W, pred) {
    for (var i = 0; i < W.inv.items.length; i++) {
      if (pred(W.inv.items[i])) return W.inv.items[i];
    }
    return null;
  }

  /**
   * 効果で薦めてよいアイテムか。
   * **未鑑定のものは薦めない** ([[D-78]] と同じ理由) ―― 薦めた時点で
   * 「これは回復薬だ」と教えることになり、フレーバー式の鑑定が骨抜きになる。
   */
  function usableKnown(W, it, prefix) {
    if (!it.effect || it.effect.indexOf(prefix) !== 0) return false;
    return Sigil.isKnownKind(W.knowledge, it.kindId);
  }

  return { MAX: MAX, list: list };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Action;
