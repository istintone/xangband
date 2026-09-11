/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* theme.js — 表示設定。docs/09 §9.9「色覚配慮」。shell 層 (DOM と localStorage を触る)。
 *
 * **色だけに情報を載せない**のが前提 ([[D-52]])。
 * そのうえで、色が読み取りにくい人のために代替パレットを用意する。
 *
 * パレットを1箇所で差し替えられる構造は M0 から確保してある ([[D-24]])ので、
 * ここは「どの値に差し替えるか」と「それを覚えておくこと」だけを担う。
 */
'use strict';

var Theme = (function () {

  var KEY = 'xangband.theme';

  /* 既定。render.js の PALETTE と同じもの。ここが正本になる。 */
  var PALETTES = {
    normal: {
      name: '標準',
      desc: '既定',
      crt: 1,
      colors: {
        black: '#05070a', dgray: '#2a3340', gray: '#5d6b7a', lgray: '#9aa8b8',
        white: '#e6edf5', red: '#c05a4e', green: '#5c9e5e', yellow: '#c9a24a',
        blue: '#4a7bb0', magenta: '#9a5fa8', cyan: '#4fa3a8', orange: '#c07a3e',
        dgreen: '#33613a', dblue: '#2d4a68', dred: '#6e3630', dyellow: '#7a6330',
        edge: '#151d27'
      }
    },

    /* 赤緑の区別に頼らない配色 (1型/2型色覚)。
       赤と緑を「明るさ」と「青〜黄の軸」で分ける ―― 色相ではなく輝度差で読ませる。 */
    deuter: {
      name: '色覚配慮',
      desc: '危険/良好/警告を輝度で分ける',
      crt: 0.6,
      /* 1型/2型では赤と緑の**色相**が当てにならない。
         そこで赤・緑・黄を**輝度で三段に**分ける ―― 暗い=危険、中=良好、明るい=警告。
         色相だけで組むと「見分けにくい配色」を作り直しただけになる。 */
      colors: {
        black: '#05070a', dgray: '#2b3038', gray: '#6a7078', lgray: '#a8aeb6',
        white: '#f0f2f5', red: '#c25a28', green: '#5fb8e8', yellow: '#f5e07a',
        blue: '#3f6fbf', magenta: '#b07ad0', cyan: '#7fd8e0', orange: '#e08a3a',
        dgreen: '#2f5f7a', dblue: '#26456a', dred: '#7a3618', dyellow: '#7d6a25',
        edge: '#141a22'
      }
    },

    /* 高コントラスト。彩度より明暗をはっきりさせる。 */
    contrast: {
      name: '高コントラスト',
      desc: '明暗をはっきりさせる',
      /* 走査線と発光を切る。**意匠のために可読性を下げない** ([[D-82]])。
         この配色を選ぶ人は、読みやすさのために選んでいる。 */
      crt: 0,
      colors: {
        black: '#000000', dgray: '#404040', gray: '#8a8a8a', lgray: '#c8c8c8',
        white: '#ffffff', red: '#ff6b5a', green: '#5aff7a', yellow: '#ffe14a',
        blue: '#6aa8ff', magenta: '#e08aff', cyan: '#5affe6', orange: '#ffab4a',
        dgreen: '#2f7a3f', dblue: '#2f5a8a', dred: '#8a3a2f', dyellow: '#8a7a2f',
        edge: '#242424'
      }
    }
  };

  var SCALES = [
    { id: 'small', name: '小', value: 0.85 },
    { id: 'normal', name: '標準', value: 1.0 },
    { id: 'large', name: '大', value: 1.2 },
    { id: 'xlarge', name: '特大', value: 1.45 }
  ];

  var state = { palette: 'normal', scale: 'normal' };
  var onChange = null;

  function palettes() {
    var out = [];
    for (var k in PALETTES) out.push({ id: k, name: PALETTES[k].name, desc: PALETTES[k].desc });
    return out;
  }

  function scales() { return SCALES.slice(); }

  function current() { return { palette: state.palette, scale: state.scale }; }

  function scaleValue() {
    for (var i = 0; i < SCALES.length; i++) if (SCALES[i].id === state.scale) return SCALES[i].value;
    return 1;
  }

  /* ---------- 適用 ---------- */

  function apply() {
    var pal = PALETTES[state.palette] || PALETTES.normal;
    // Render.PALETTE を差し替える。端末も枠外UI も同じ表を見ている
    for (var k in pal.colors) Render.PALETTE[k] = pal.colors[k];

    if (typeof document !== 'undefined' && document.documentElement) {
      var root = document.documentElement.style;
      root.setProperty('--bg', pal.colors.black);
      root.setProperty('--ink', pal.colors.white);
      root.setProperty('--dim', pal.colors.gray);
      root.setProperty('--accent', pal.colors.cyan);
      root.setProperty('--warn', pal.colors.yellow);
      root.setProperty('--danger', pal.colors.red);
      root.setProperty('--tip', pal.colors.cyan);
      root.setProperty('--ui-scale', String(scaleValue()));
      // コンソール意匠の強度 (docs/09 §9.16)
      root.setProperty('--crt', String(pal.crt === undefined ? 1 : pal.crt));
    }
    if (onChange) onChange();
  }

  function set(what, value) {
    if (what === 'palette' && PALETTES[value]) state.palette = value;
    else if (what === 'scale') {
      for (var i = 0; i < SCALES.length; i++) if (SCALES[i].id === value) state.scale = value;
    } else return false;
    save();
    apply();
    return true;
  }

  /** 次の候補へ回す。キー1つで切り替えられるようにするため。 */
  function cycle(what) {
    var list = what === 'palette' ? palettes() : scales();
    var cur = state[what];
    var i = 0;
    for (var n = 0; n < list.length; n++) if (list[n].id === cur) i = n;
    return set(what, list[(i + 1) % list.length].id);
  }

  /* ---------- 永続化 ---------- */

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 保存できなくても続行 */ }
  }

  function load() {
    try {
      var s = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (s && PALETTES[s.palette]) state.palette = s.palette;
      if (s && s.scale) state.scale = s.scale;
    } catch (e) { /* 読めなくても既定で動く */ }
  }

  /** @param notify 変更時に呼ぶ (再描画のため) */
  function init(notify) {
    onChange = notify || null;
    load();
    apply();
  }

  return {
    KEY: KEY, PALETTES: PALETTES, SCALES: SCALES,
    palettes: palettes, scales: scales, current: current, scaleValue: scaleValue,
    init: init, apply: apply, set: set, cycle: cycle, load: load
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Theme;
