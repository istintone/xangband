/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* legend.js — 凡例HUD の中身を計算する。docs/09 §9.11 ([[D-56]])。DOM 非依存。
 *
 * 原則: **今画面にあるものだけ**を出す。全一覧は出さない。
 * 初心者が知りたいのは目の前の `d` が何かであって、全24種の敵ではない。
 *
 * DOM を触らないので、「この状況でこのヒントが出る」をテストできる。
 */
'use strict';

var Legend = (function () {

  /* ---------- 見えているもの ---------- */

  /**
   * 今視界にある地形・敵・アイテムを、重複を除いて並べる。
   * @returns {object} { terrain: [], monsters: [], items: [] }
   */
  function visible(W) {
    var lv = W.level, out = { terrain: [], monsters: [], items: [] };
    if (!lv) return out;

    var seenTile = {}, seenMon = {}, seenItem = {};
    var i;

    // 地形: 既知グリッドに出ている種類
    for (i = 0; i < lv.tiles.length; i++) {
      if (!(lv.flags[i] & World.F.KNOWN)) continue;
      var t = lv.tiles[i];
      if (seenTile[t]) continue;
      seenTile[t] = true;
      var g = Render.glyphFor(W, t);       // 地図と同じ見た目を出す
      if (!g) continue;
      out.terrain.push({
        ch: g.ch, color: g.lit,
        label: World.TILE_INFO[t].name,
        detail: TILE_HELP[t] || ''
      });
    }

    // 敵: 見えている / 検出済みのもの。同じ種族はまとめる。
    for (i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      var vis = World.hasFlag(lv, a.x, a.y, World.F.VISIBLE);
      if (!vis && !a.detected) continue;
      if (seenMon[a.raceId]) { seenMon[a.raceId].count++; continue; }

      var base = Data.get().monsterBase[a.base];
      var entry = {
        ch: a.glyph, color: a.asleep > 0 ? 'dgray' : a.color,
        label: a.name, count: 1,
        detail: (base ? base.name : '') + (a.asleep > 0 ? ' / 眠っている' : ''),
        raceId: a.raceId, asleep: a.asleep > 0
      };
      seenMon[a.raceId] = entry;
      out.monsters.push(entry);
    }

    // アイテム: 既知グリッドにあるもの
    for (i = 0; i < W.items.length; i++) {
      var it = W.items[i];
      if (!World.hasFlag(lv, it.x, it.y, World.F.KNOWN)) continue;
      var key = it.kindId + '/' + (it.egoId || '') + '/' + (it.uniqueId || '');
      if (seenItem[key]) { seenItem[key].count++; continue; }
      var ie = {
        ch: it.glyph,
        color: it.uniqueId ? 'yellow' : (it.egoId ? 'cyan' : (it.tainted ? 'magenta' : it.color)),
        label: Sigil.name(W.knowledge, it), count: 1,
        detail: Data.get().itemBase[it.base].name
      };
      seenItem[key] = ie;
      out.items.push(ie);
    }

    // プレイヤーは必ず先頭に
    out.terrain.unshift({ ch: '@', color: 'white', label: 'あなた', detail: '' });
    return out;
  }

  var TILE_HELP = {};
  TILE_HELP[World.TILE.WALL] = '通れない';
  TILE_HELP[World.TILE.FLOOR] = '通れる';
  TILE_HELP[World.TILE.DOOR] = '通れる。方舟では気圧を区切っている';
  TILE_HELP[World.TILE.DOWN] = '> で深く潜る';
  TILE_HELP[World.TILE.UP] = '< で戻る';
  TILE_HELP[World.TILE.TRAP] = '踏むと作動する';
  TILE_HELP[World.TILE.SHOP] = 'Enter で入る';
  TILE_HELP[World.TILE.TERM] = 'J で接続する。階そのものに干渉できる';

  /* ---------- 状態の意味 ---------- */

  /**
   * サイドバーに出ている各項目が何かを説明する。
   * 出ていないものは説明しない(サイドバーと1対1で対応させる)。
   */
  function status(W) {
    var p = W.player, out = [];
    if (!p) return out;

    out.push({ label: 'HP', value: p.hp + '/' + p.hpMax,
               help: '0 になると死ぬ。休息(R)と時間で回復する' });
    if (p.system) {
      out.push({ label: Ability.SYSTEM_NAME[p.system], value: p.sp + '/' + p.spMax,
                 help: '能力(m)を使うと減る' });
    }
    if (p.cog < p.cogMax) {
      out.push({ label: '認知', value: p.cog + '/' + p.cogMax,
                 help: '端末(J)に接続すると減る。時間でしか戻らない。0 で昏倒' });
    }
    out.push({ label: 'AC', value: String(p.ac || 0),
               help: '高いほど敵の攻撃が当たりにくい' });
    out.push({ label: '速度', value: Turn.speedLabel(Turn.effectiveSpeed(p)),
               help: '+10 で行動回数が2倍。最も重要な値' });
    out.push({ label: '深度', value: W.depth === 0 ? '母船' : String(W.depth),
               help: '唯一の難易度尺度。深いほど強い敵と良い品が出る' });
    if (W.depth > 0 && W.site) {
      out.push({ label: W.site.short, value: W.site.depthMin + '〜' + W.site.depthMax,
                 help: 'この場所の深度レンジ。最深部のユニークが《適合》を落とす' });
    }
    out.push({ label: '電力', value: String(p.cells),
               help: 'ライトと射出器の燃料。0 になると光が消える' });
    out.push({ label: '食料', value: String(Math.floor(p.food / 100)),
               help: '0 になると衰弱して減り続ける' });

    if (W.depth > 0 && W.feeling) {
      out.push({ label: '危険', value: String(W.feeling.danger),
                 help: '0〜9。この階にどれだけ強い敵がいるか' });
      out.push({ label: '有望', value: W.feeling.lootKnown ? String(W.feeling.loot) : '?',
                 help: '0〜9。歩き回ると分かる' });
    }

    var warn = Env.warnings(W);
    for (var i = 0; i < warn.length; i++) {
      out.push({ label: warn[i].label, value: warn[i].value,
                 color: warn[i].color, help: WARN_HELP[warn[i].label] || '' });
    }
    return out;
  }

  var WARN_HELP = {
    '気密': '左が今の気密、右がこの階で必要な量。足りないと毎ターン減る',
    '被曝': '溜まると能力値が落ちる。母船の情報屋で除染できる',
    '汚染': '溜まると変異する。良い変異も悪い変異もある',
    '補足': '監視に見つかっている。増援が来る'
  };

  /* ---------- 状況に応じたヒント ---------- */

  /**
   * 「今何をすべきか」を状況から出す。
   * これが枠外UI の中心。チュートリアルを書かずに操作を教える。
   * @returns {Array} { level: 'danger'|'warn'|'info'|'tip', text }
   */
  function hints(W) {
    var out = [];
    if (!W || !W.player) return out;
    var p = W.player, lv = W.level;

    if (W.dead) {
      out.push({ level: 'danger', text: 'あなたは死んだ。N で新しいランを始める。' });
      return out;
    }

    /* --- 生死に関わるもの --- */
    var deficit = Env.sealDeficit(W);
    if (deficit > 0) {
      out.push({ level: 'danger',
        text: '気密が足りない。ここには居られない。' +
              '< で戻るか、気密のあるスーツ(装甲廠で買える)を装備すること。' });
    }
    if (p.hp * 3 < p.hpMax) {
      out.push({ level: 'danger',
        text: 'HP が危険。u で回復アイテムを使うか、< で戻ること。' });
    }
    if (p.food < 500 && !Player.hasFlag(p, 'NO_FOOD')) {
      out.push({ level: 'warn', text: '空腹。u で携行食を食べること。' });
    }
    if (p.cells <= 0) {
      out.push({ level: 'warn',
        text: '電力が尽きた。ライトが点かない。u で電力セルを装填すること。' });
    } else if (p.cells < 60) {
      out.push({ level: 'warn', text: '電力が少ない。L でライトを消せば節約できる。' });
    }
    if (p.exposure >= Env.EXPOSURE_STEP) {
      out.push({ level: 'warn', text: '被曝が進んでいる。母船の情報屋で除染できる。' });
    }
    if (p.contamination >= Env.CONTAMINATION_STEP) {
      out.push({ level: 'warn', text: '汚染が進んでいる。次の閾値で変異する。' });
    }

    /* --- 目の前の状況 --- */
    var adjacent = null, sleepingAdjacent = null, visibleCount = 0;
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      if (!World.hasFlag(lv, a.x, a.y, World.F.VISIBLE)) continue;
      visibleCount++;
      if (U.distCheb(a.x, a.y, p.x, p.y) === 1) {
        adjacent = a;
        if (a.asleep > 0) sleepingAdjacent = a;
      }
    }

    if (sleepingAdjacent) {
      out.push({ level: 'tip',
        text: sleepingAdjacent.name + 'は眠っている。今攻撃すれば必ず当たり、不意打ちになる。' });
    } else if (adjacent) {
      out.push({ level: 'info',
        text: adjacent.name + 'が隣にいる。その方向へ移動すると攻撃する。' });
    }

    if (visibleCount >= 2 && !W.target) {
      out.push({ level: 'tip', text: 'x で目標を選べる。奥の敵を狙える。' });
    }

    /* 足元のものは action.js が**押せる行動**として出す ([[D-85]])。
       ここで同じことを文章でも書くと、ガイドに同じ助言が二度並ぶ。
       ヒントは「なぜそうすべきか」を担い、行動そのものは Action が担う。 */

    /* --- 持ち物 --- */
    var wearable = null;
    for (var j = 0; j < W.inv.items.length; j++) {
      if (W.inv.items[j].slot) { wearable = W.inv.items[j]; break; }
    }
    if (wearable) {
      out.push({ level: 'tip',
        text: '装備できるものを持っている。w で装備できる。' });
    }
    if (W.inv.items.length >= Inventory.MAX_ITEMS) {
      out.push({ level: 'warn', text: '所持品がいっぱい。d で不要なものを置くこと。' });
    }

    /* 成長・拾得・装備といった「押せば済むこと」は action.js が担う ([[D-85]])。
       ここは**そうすべき理由と、その危うさ**だけを言う。 */

    /* --- 電脳層 (docs/11 §11.3) --- */
    if (typeof Net !== 'undefined' && Net.atTerminal(W)) {
      out.push({ level: 'warn',
        text: '接続中に認知が尽きると昏倒する。端末の前で無防備になるので、' +
              '周囲を片付けてからにするか、賭けるかを決めること。' });
    }
    if (typeof Net !== 'undefined' && Net.isBlinded(W)) {
      out.push({ level: 'tip', text: '走査系を止めてある。しばらく補足されない。' });
    }

    /* --- サイト固有の助言 (docs/10 §10.2) --- */
    var sig = W.site && W.site.signature;
    if (W.depth > 0 && sig === 'pressure') {
      out.push({ level: 'tip',
        text: '区画ごとに気圧が違う。隔壁扉(+)を通ると気圧が均され、' +
              '差が大きいと突風で敵ごと吹き飛ぶ。' });
    } else if (W.depth > 0 && sig === 'daynight') {
      out.push({ level: 'tip',
        text: (W.level && W.level.night)
          ? '夜。暗いが被曝は少ない。敵は強い。'
          : '昼。見通しは良いが被曝する。遮蔽物の陰にいれば被曝が減る。' });
    } else if (W.depth > 0 && sig === 'surveillance' && W.alerted) {
      out.push({ level: 'danger',
        text: '監視網に補足されている。増援が湧き続ける。' +
              '階を移るか、端末(Ω)で監視を切るか、L でライトを消すこと。' });
    } else if (W.depth > 0 && sig === 'dark') {
      out.push({ level: 'tip',
        text: '光源が無い。ライトの半径が視界の全て。電力が尽きたら何も見えない。' });
    }

    /* --- 母船は助言が全く違う場面なので専用にする --- */
    if (W.depth === 0) {
      out.push({ level: 'tip',
        text: '交易区(=)に Enter で入れる。装甲廠で気密のあるスーツ、' +
              '補給所で携行食と電力セルを買っておくこと。' });
      if (p.exposure > 0 || p.contamination > 0) {
        out.push({ level: 'tip', text: '情報屋で除染を受けられる(C)。' });
      }
      out.push({ level: 'info',
        text: '中央の降下ポッド(>)から、選んだ場所の到達最深部へ降りられる。' });
      if (typeof Site !== 'undefined') {
        var n = Site.adaptationCount(W);
        out.push({ level: n >= 4 ? 'tip' : 'info',
          text: 'V で降下先を選ぶ。《適合》' + n + '/4' +
                (n >= 4 ? ' ―― 《起源》へ行ける。' : '。4つ揃うと《起源》へ行ける。') });
      }
      return out;
    }

    /* --- 入ったばかりで地図がほとんど白紙のとき --- */
    if (lv && lv.tiles) {
      var known = 0;
      for (var k = 0; k < lv.flags.length; k++) if (lv.flags[k] & World.F.KNOWN) known++;
      if (known / lv.flags.length < 0.04) {
        out.push({ level: 'info',
          text: '見えていない場所は表示されない。歩いて地図を作る。' +
                'ライトの半径が視界の全て。' });
      }
    }

    /* --- 何も無いときの基本 --- */
    if (out.length === 0) {
      out.push({ level: 'info',
        text: '降下シャフト(>)を探して深く潜る。深度が唯一の難易度尺度。' });
    }
    return out;
  }

  /** 全部まとめて。panel.js はこれだけを呼ぶ。 */
  function compute(W) {
    return { visible: visible(W), status: status(W), hints: hints(W) };
  }

  return {
    compute: compute, visible: visible, status: status, hints: hints,
    TILE_HELP: TILE_HELP, WARN_HELP: WARN_HELP
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Legend;
