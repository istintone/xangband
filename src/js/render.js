/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* render.js — 世界状態 W からグリフバッファへの純粋な写像。DOM 非依存。
 *
 * docs/01 §1.6 (D-22):
 *   W ──(ここ)──> グリフバッファ ──> 描画器 (term.js = ASCII / 将来タイル)
 * ここまで DOM に触れないので、「このシードのこのターンで画面がこう見える」
 * というスナップショットテストが書ける。
 */
'use strict';

var Render = (function () {

  /* 端末レイアウト (docs/09 §9.2, [[D-48]])。基準 80x40。
     行0-1 メッセージ / 列0-15 サイドバー / 残りがマップ。
     全角ラベルが2桁を食うため、サイドバーは 16桁必要。

     **桁数は画面に合わせて 80 以上へ広がる** ([[D-84]])。
     16:9 の画面では 80桁だと高さで頭打ちになり、左右に黒帯が残っていた。
     マップのビューポートは元から可変 ([[D-21]]) なので、桁が増えればマップが広がる。
     行数は 40 固定 ―― 縦に伸ばすと1画面の情報量が増えすぎ、端末らしさが崩れる。 */
  var COLS_MIN = 80, COLS_MAX = 140;
  /* 携帯の縦画面では 80桁が読めない。サイドバーを外して 42桁まで下げる ([[D-87]])。
     サイドバーの中身は枠外の HUD が同じものを既に出しているので、情報は失われない。 */
  var COLS_MIN_NARROW = 42;
  var SIDEBAR_W = 16;       // 列0..15 = サイドバー (出しているときだけ)
  var MSG_ROWS = 2;         // 行0..1 = メッセージ(最新2件)

  var TERM = { w: COLS_MIN, h: 40 };
  var sidebar = true;       // 端末の中にサイドバーを描くか
  var MAP = { x: SIDEBAR_W, y: MSG_ROWS, w: TERM.w - SIDEBAR_W, h: TERM.h - MSG_ROWS };

  function hasSidebar() { return sidebar; }
  function sidebarW() { return sidebar ? SIDEBAR_W : 0; }

  /** その構成で許される最小桁数。 */
  function minCols(withSidebar) {
    return withSidebar ? COLS_MIN : COLS_MIN_NARROW;
  }

  /**
   * 端末の構成を変える。**TERM / MAP は同じオブジェクトのまま書き換える** ―
   * 他のモジュールが参照を握っているので、差し替えると古い値を見続ける。
   * @param withSidebar 省略すると現在の設定を保つ
   * @returns {boolean} 実際に変わったら true
   */
  function resize(cols, withSidebar) {
    var side = withSidebar === undefined ? sidebar : !!withSidebar;
    var w = Math.max(minCols(side), Math.min(COLS_MAX, Math.floor(cols) || minCols(side)));
    if (w === TERM.w && side === sidebar) return false;
    sidebar = side;
    TERM.w = w;
    MAP.x = sidebarW();
    MAP.w = w - sidebarW();
    return true;
  }

  /* 16色パレット。コードに生の #rrggbb を書かない (D-24)。
     色覚配慮パレットへの差し替えはここだけを触る。 */
  var PALETTE = {
    black:    '#05070a', dgray:  '#2a3340', gray:    '#5d6b7a', lgray:  '#9aa8b8',
    white:    '#e6edf5', red:    '#c05a4e', green:   '#5c9e5e', yellow: '#c9a24a',
    blue:     '#4a7bb0', magenta:'#9a5fa8', cyan:    '#4fa3a8', orange: '#c07a3e',
    dgreen:   '#33613a', dblue:  '#2d4a68', dred:    '#6e3630', dyellow:'#7a6330',
    edge:     '#151d27'          // サイドバーとマップの区切り帯
  };

  /* 地形のグリフ。見えている時と記憶の時で色を変える。 */
  /**
   * その地形を今どう描くか。**サイトごとに壁と床の見た目が変わる**
   * (docs/10 §10.5) ので、地形のグリフを引く箇所は全部ここを通す。
   * 凡例HUD が別に持つと「地図は `'` なのに凡例は `+`」がすぐ起きる ([[D-56]])。
   */
  function glyphFor(W, tile) {
    var site = W && W.site;
    return (site && typeof Site !== 'undefined' && Site.tileGlyph(site, tile)) ||
           TILE_GLYPH[tile];
  }

  var TILE_GLYPH = {};
  TILE_GLYPH[World.TILE.WALL]  = { ch: '#', lit: 'gray',   mem: 'dgray'  };
  TILE_GLYPH[World.TILE.FLOOR] = { ch: '.', lit: 'lgray',  mem: 'dgray'  };
  TILE_GLYPH[World.TILE.DOOR]  = { ch: '+', lit: 'orange', mem: 'dyellow'};
  TILE_GLYPH[World.TILE.DOWN]  = { ch: '>', lit: 'white',  mem: 'gray'   };
  TILE_GLYPH[World.TILE.UP]    = { ch: '<', lit: 'white',  mem: 'gray'   };
  TILE_GLYPH[World.TILE.TRAP]  = { ch: '^', lit: 'red',    mem: 'dred'   };
  TILE_GLYPH[World.TILE.SHOP]  = { ch: '=', lit: 'yellow', mem: 'dyellow'};
  TILE_GLYPH[World.TILE.TERM]  = { ch: 'Ω', lit: 'cyan',   mem: 'dblue'  };

  /**
   * 全角判定。固定幅グリッドに日本語を書くので、CJK は 2セルを占有させる。
   * これをしないとメッセージ行以降の桁が全てズレる。
   */
  function isWide(ch) {
    var c = ch.codePointAt(0);
    return (c >= 0x1100 && c <= 0x115F) ||   // ハングル字母
           (c >= 0x2E80 && c <= 0xA4CF) ||   // CJK 部首〜漢字・かな・記号
           (c >= 0xAC00 && c <= 0xD7A3) ||   // ハングル音節
           (c >= 0xF900 && c <= 0xFAFF) ||   // CJK 互換漢字
           (c >= 0xFE30 && c <= 0xFE6F) ||   // CJK 互換形
           (c >= 0xFF00 && c <= 0xFF60) ||   // 全角英数
           (c >= 0xFFE0 && c <= 0xFFE6) ||
           (c >= 0x20000 && c <= 0x3FFFD);   // CJK 拡張
  }

  /**
   * 空のグリフバッファ。cells[y*w+x] = {ch, fg, bg, w}
   *   w=1 半角 / w=2 全角の先頭 / w=0 全角の後続 (描画器は読み飛ばす)
   */
  function createBuffer(w, h) {
    var cells = new Array(w * h);
    for (var i = 0; i < cells.length; i++) cells[i] = { ch: ' ', fg: 'white', bg: 'black', w: 1 };
    return { w: w, h: h, cells: cells };
  }

  /** 1文字置く。戻り値は消費したセル数 (0 = 置けなかった)。 */
  function put(buf, x, y, ch, fg, bg) {
    if (x < 0 || y < 0 || x >= buf.w || y >= buf.h) return 0;
    var wide = isWide(ch) ? 2 : 1;
    if (wide === 2 && x + 1 >= buf.w) return 0;   // 右端に全角は入れない

    var c = buf.cells[y * buf.w + x];
    c.ch = ch; c.fg = fg || 'white'; c.bg = bg || 'black'; c.w = wide;
    if (wide === 2) {
      var c2 = buf.cells[y * buf.w + x + 1];
      c2.ch = ''; c2.fg = c.fg; c2.bg = c.bg; c2.w = 0;
    }
    return wide;
  }

  /** 文字列を書く。maxW セルを超える分は切る。戻り値は消費したセル数。 */
  function text(buf, x, y, str, fg, bg, maxW) {
    var limit = maxW === undefined ? buf.w - x : Math.min(maxW, buf.w - x);
    var col = 0;
    // コードポイント単位で回す (サロゲートペアを割らない)
    var chars = Array.from(String(str));
    for (var i = 0; i < chars.length; i++) {
      var wide = isWide(chars[i]) ? 2 : 1;
      if (col + wide > limit) break;
      put(buf, x + col, y, chars[i], fg, bg);
      col += wide;
    }
    return col;
  }

  /**
   * マップビューポートの左上座標。プレイヤーを中心に置き、マップ端でクランプする。
   * マップが画面より小さい場合は 0 に張り付く。
   */
  function viewOrigin(lv, px, py) {
    return {
      x: U.clamp(px - (MAP.w >> 1), 0, Math.max(0, lv.w - MAP.w)),
      y: U.clamp(py - (MAP.h >> 1), 0, Math.max(0, lv.h - MAP.h))
    };
  }

  function drawMap(buf, W) {
    var lv = W.level, p = W.player;
    // 注視中はカーソルを追う。画面外の敵を見に行けるようにする。
    var focus = W.cursor || p;
    var o = viewOrigin(lv, focus.x, focus.y);
    var i;

    // 1) 地形。既知グリッドだけを描く。
    for (var sy = 0; sy < MAP.h; sy++) {
      for (var sx = 0; sx < MAP.w; sx++) {
        var mx = o.x + sx, my = o.y + sy;
        if (!World.inBounds(lv, mx, my)) continue;
        if (!World.hasFlag(lv, mx, my, World.F.KNOWN)) continue;  // 未踏は空白のまま

        var tile = World.getTile(lv, mx, my);
        var g = glyphFor(W, tile);
        var visible = World.hasFlag(lv, mx, my, World.F.VISIBLE);
        put(buf, MAP.x + sx, MAP.y + sy, g.ch, visible ? g.lit : g.mem, 'black');
      }
    }

    // 2) 床のアイテム。既知グリッドなら記憶として残す (本家準拠: 地形は覚える)。
    for (i = 0; W.items && i < W.items.length; i++) {
      var it = W.items[i];
      if (!World.hasFlag(lv, it.x, it.y, World.F.KNOWN)) continue;
      var lit = World.hasFlag(lv, it.x, it.y, World.F.VISIBLE);
      putMap(buf, o, it.x, it.y, it.glyph, lit ? it.color : 'dgray');
    }

    // 3) 敵。見えているものだけ。記憶しない (docs/02 §2.2)。
    //    検出(detect)されたものは、見えていなくても薄く表示する。
    for (i = 0; W.actors && i < W.actors.length; i++) {
      var a = W.actors[i];
      if (a.dead || a.kind === 'player') continue;
      var vis = World.hasFlag(lv, a.x, a.y, World.F.VISIBLE);
      if (!vis && !a.detected) continue;
      var color = vis ? a.color : 'dgray';
      // 眠っている敵は暗く出す。不意打ちの機会が目で分かる ([[D-40]])。
      if (vis && a.asleep > 0) color = 'dgray';
      putMap(buf, o, a.x, a.y, a.glyph, color);
    }

    // 4) プレイヤーは最後 (何にも隠されない)
    putMap(buf, o, p.x, p.y, '@', 'white');

    // 5) 注視カーソル / 指定中の目標 ([[D-49]])
    var tgt = W.target && Target.resolve(W);
    if (tgt) putMap(buf, o, tgt.x, tgt.y, '*', 'yellow');
    if (W.cursor) putMap(buf, o, W.cursor.x, W.cursor.y, 'X', 'cyan');

    return o;
  }

  /** マップ座標で1マス置く。ビューポート外なら何もしない。 */
  function putMap(buf, o, mx, my, ch, fg) {
    var sx = mx - o.x, sy = my - o.y;
    if (sx < 0 || sy < 0 || sx >= MAP.w || sy >= MAP.h) return;
    put(buf, MAP.x + sx, MAP.y + sy, ch, fg, 'black');
  }

  /* 状態異常の表示。短い記号で並べる。 */
  var TIMER_TAG = {
    poison: ['汚染', 'green'], confused: ['混乱', 'magenta'], afraid: ['恐慌', 'yellow'],
    paralyzed: ['麻痺', 'red'], blind: ['盲目', 'dgray'], haste: ['加速', 'cyan'], slow: ['減速', 'dred']
  };

  function drawSidebar(buf, W) {
    var p = W.player;
    var row = MSG_ROWS;          // メッセージ行の下から始める
    function line(label, value, fg) {
      // ラベルが全角を含むので、実際に消費したセル数を使って値を置く
      var used = text(buf, 0, row, label, 'gray', 'black', SIDEBAR_W);
      if (value !== undefined) {
        text(buf, used + 1, row, value, fg || 'white', 'black', SIDEBAR_W - used - 1);
      }
      row++;
    }
    text(buf, 0, row++, 'STRATA', 'cyan');
    line('Lv', String(p.level), 'white');
    line('EXP', String(p.exp));
    row++;
    line('HP', p.hp + '/' + p.hpMax, p.hp * 2 < p.hpMax ? 'red' : 'green');
    if (p.system) {
      line(Ability.SYSTEM_NAME[p.system], p.sp + '/' + p.spMax,
           p.sp === 0 ? 'gray' : 'magenta');
    }
    // 認知は電脳層の資源 (docs/11 §11.2)。端末に出会う場所でだけ意味を持つので、
    // 満タンのときは出さない ―― サイドバーは常に見る場所であって、辞書ではない
    if (p.cog < p.cogMax) {
      line('認知', p.cog + '/' + p.cogMax, p.cog === 0 ? 'red' : 'cyan');
    }
    line('AC', String(p.ac || 0));
    line('速度', Turn.speedLabel(Turn.effectiveSpeed(p)),
         Turn.effectiveSpeed(p) < Turn.NORMAL_SPEED ? 'red' :
         (Turn.effectiveSpeed(p) > Turn.NORMAL_SPEED ? 'cyan' : 'white'));
    row++;
    line('深度', W.depth === 0 ? '母船' : String(W.depth), 'yellow');
    if (W.depth > 0 && W.site) text(buf, 0, row++, W.site.short, 'cyan', 'black', SIDEBAR_W);
    line('電力', String(p.cells), p.cells < 50 ? 'red' : 'cyan');
    line('食料', String(Math.floor(p.food / 100)), p.food < 500 ? 'red' : 'white');
    line('$', String(W.inv ? W.inv.credits : 0), 'yellow');
    row++;

    // 階の予感 (docs/02 §2.3)。有望度は歩いて初めて開示される。
    if (W.depth > 0 && W.feeling) {
      var d = U.clamp(W.feeling.danger, 0, 9);
      line('危険', String(d), d >= 6 ? 'red' : (d >= 3 ? 'yellow' : 'gray'));
      line('有望', W.feeling.lootKnown ? String(U.clamp(W.feeling.loot, 0, 9)) : '?',
           W.feeling.lootKnown && W.feeling.loot >= 6 ? 'cyan' : 'gray');
    }

    // 環境の警告。**危険な値だけ**を出す (docs/08 §8.8)。
    // 出ている = 何か起きている、という読み方を成立させる。
    var warn = Env.warnings(W);
    if (warn.length) {
      row++;
      for (var wi = 0; wi < warn.length; wi++) {
        line(warn[wi].label, warn[wi].value, warn[wi].color);
      }
    }

    // 状態異常
    var anyTimer = false;
    for (var k in TIMER_TAG) {
      if (p.timers && p.timers[k] > 0) {
        if (!anyTimer) { row++; anyTimer = true; }
        text(buf, 0, row++, TIMER_TAG[k][0], TIMER_TAG[k][1], 'black', SIDEBAR_W);
      }
    }

    // 指定中の目標 ([[D-49]])
    var tgt = W.target && Target.resolve(W);
    if (tgt) {
      row++;
      text(buf, 0, row++, '目標', 'gray', 'black', SIDEBAR_W);
      text(buf, 0, row++, tgt.name, 'yellow', 'black', SIDEBAR_W);
    }

    // シードは常時表示する。不具合報告と再現に必須なので隠さない。
    text(buf, 0, TERM.h - 3, 'T ' + W.turn, 'dgray', 'black', SIDEBAR_W);
    text(buf, 0, TERM.h - 2, 'seed', 'dgray', 'black', SIDEBAR_W);
    text(buf, 0, TERM.h - 1, String(W.seed).slice(0, SIDEBAR_W), 'dgray', 'black', SIDEBAR_W);

    /* サイドバーとマップの区切り。'|' のグリフだとセル高より文字が低く、
       縦に隙間が空いて点線に見える。背景色の帯にすると繋がる。 */
    for (var y = MSG_ROWS; y < TERM.h; y++) put(buf, SIDEBAR_W - 1, y, ' ', 'edge', 'edge');
  }

  /** メッセージは最新2件。新しいものが上 (docs/09 §9.2)。 */
  function drawMessages(buf, W) {
    var n = W.messages.length;
    for (var i = 0; i < MSG_ROWS; i++) {
      var m = W.messages[n - 1 - i];
      if (!m) break;
      var s = m.text + (m.count > 1 ? ' (x' + m.count + ')' : '');
      text(buf, 0, i, s, i === 0 ? 'white' : 'gray', 'black', TERM.w);
    }
  }

  /**
   * 世界状態 W からグリフバッファを作る。副作用なし。
   * **W が null でも落ちない。** キャラクター作成画面は世界が存在する前に描かれる。
   */
  function frame(W) {
    var buf = createBuffer(TERM.w, TERM.h);
    if (!W) {
      text(buf, 2, 1, 'STRATA', 'cyan');
      return buf;
    }
    if (W.level) drawMap(buf, W);
    if (sidebar) drawSidebar(buf, W);
    drawMessages(buf, W);
    return buf;
  }

  /** テスト・デバッグ用: バッファを文字列にする (色は落ちる)。
   *  全角の後続セル (w=0) は飛ばすので、CJK を2桁で表示する端末で桁が揃う。 */
  function toText(buf) {
    var out = [];
    for (var y = 0; y < buf.h; y++) {
      var s = '';
      for (var x = 0; x < buf.w; x++) {
        var c = buf.cells[y * buf.w + x];
        if (c.w === 0) continue;
        s += c.ch;
      }
      out.push(s.replace(/\s+$/, ''));
    }
    return out.join('\n');
  }

  return {
    TERM: TERM, MAP: MAP, SIDEBAR_W: SIDEBAR_W, MSG_ROWS: MSG_ROWS,
    COLS_MIN: COLS_MIN, COLS_MAX: COLS_MAX, COLS_MIN_NARROW: COLS_MIN_NARROW,
    resize: resize, hasSidebar: hasSidebar, sidebarW: sidebarW, minCols: minCols,
    PALETTE: PALETTE, TILE_GLYPH: TILE_GLYPH, glyphFor: glyphFor,
    isWide: isWide,
    createBuffer: createBuffer, put: put, text: text, putMap: putMap,
    viewOrigin: viewOrigin, frame: frame, toText: toText
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Render;
