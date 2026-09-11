/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* site.js — サイト(降下先)。docs/08 §8.7, docs/10。DOM 非依存。
 *
 * 深度は全サイト共通の絶対値 ([[D-03]])。サイトが変えるのは
 * **地形生成器・敵プール・環境ハザード・固有報酬**だけで、強さの基準は動かさない。
 *
 * まずパラメータで到達できる差を使い切る (docs/10 §10.5)。
 * 生成アルゴリズムを4本書く前に、部屋の形・照明・グリフ・色・敵の重みで印象を変える。
 */
'use strict';

var Site = (function () {

  function all() { return Data.get().sites; }
  function byId(id) { return Data.get().sitesById[id]; }

  /**
   * 最初から降りられるサイト(深度1から始まるもの)。
   * **最深部が浅い順**に並べる。浅いサイトほど要求装備が軽く、入門になる。
   * 先頭が新規ランの既定の降下先になる ([[D-61]])。
   */
  function starting() {
    return all().filter(function (s) { return s.depthMin <= 1; })
      .sort(function (a, b) { return a.depthMax - b.depthMax; });
  }

  /** その深度で潜れるサイト。 */
  function availableAt(depth) {
    return all().filter(function (s) {
      return depth >= s.depthMin && depth <= s.depthMax;
    });
  }

  /* ---------- ランごとの進捗 ---------- */

  /**
   * サイトごとの到達最深度と《適合》の取得状況。
   * 深度そのものは共通尺度だが、**どのサイトをどこまで潜ったか**は別に覚える。
   */
  function createProgress() {
    var p = { depthMax: {}, adaptations: {} };
    var list = all();
    for (var i = 0; i < list.length; i++) p.depthMax[list[i].id] = 0;
    return p;
  }

  function noteDepth(W, siteId, depth) {
    if (!W.progress) W.progress = createProgress();
    if (depth > (W.progress.depthMax[siteId] || 0)) {
      W.progress.depthMax[siteId] = depth;
    }
  }

  function deepestIn(W, siteId) {
    return (W.progress && W.progress.depthMax[siteId]) || 0;
  }

  /** 《適合》を得ているか (docs/07 §7.2)。 */
  function hasAdaptation(W, kind) {
    return !!(W.progress && W.progress.adaptations[kind]);
  }

  function grantAdaptation(W, kind) {
    if (!W.progress) W.progress = createProgress();
    if (W.progress.adaptations[kind]) return false;
    W.progress.adaptations[kind] = true;
    return true;
  }

  var ADAPTATION_NAME = {
    vacuum: '真空', radiation: '放射', contamination: '汚染', watch: '監視'
  };

  function adaptationCount(W) {
    return W.progress ? Object.keys(W.progress.adaptations).length : 0;
  }

  /* ---------- 生成 ---------- */

  /** そのサイトの生成パラメータ。gen-common の DEFAULTS に重ねる。 */
  function genOpts(site) {
    var o = {};
    if (site && site.gen) for (var k in site.gen) o[k] = site.gen[k];
    if (site && site.rooms) o.roomPool = site.rooms;
    if (site && site.termChance !== undefined) o.termChance = site.termChance;
    return o;
  }

  /**
   * サイトの重みを掛けた敵の抽選。
   * 深度による強さの基準は動かさず、**どの系統が出やすいか**だけを変える ([[D-03]])。
   */
  function pickMonster(rng, site, depth) {
    if (!site || !site.weight) return Data.pickMonster(rng, depth);

    /* 重み付き棄却抽選。**最大の重みで割る**のが肝。
       以前は「1以上なら即採用」としていたので、
       weight 2.5 と 1.2 が同じ扱いになり、**強調したい系統が強調されなかった**。
       《起源》は異常種2.5 を指定しているのに機械が最多になっていた ([[D-76]])。
       深度による強さの基準は動かさず、顔ぶれだけを変える ([[D-03]])。 */
    var maxW = maxWeight(site);
    for (var tries = 0; tries < 12; tries++) {
      var race = Data.pickMonster(rng, depth);
      if (!race) return null;
      var w = site.weight[race.base];
      if (w === undefined) w = 1;
      if (rng.float() < w / maxW) return race;
    }
    return Data.pickMonster(rng, depth);             // 諦めて素で引く
  }

  /** そのサイトで最も重い系統の重み。抽選の正規化に使う。 */
  function maxWeight(site) {
    if (site._maxWeight) return site._maxWeight;
    var m = 1;
    for (var k in site.weight) m = Math.max(m, site.weight[k]);
    site._maxWeight = m;
    return m;
  }

  /* ---------- 見た目 ---------- */

  /**
   * 地形グリフの差し替え。生成器を書かずに印象を変える最も安い手段
   * (docs/10 §10.5)。
   */
  function tileGlyph(site, tile) {
    if (!site || !site.look) return null;
    var key = tileKey()[tile];
    return key ? site.look[key] || null : null;
  }

  /* 遅延構築する。site.js は world.js より先に読まれるので、
     モジュール読み込み時に World を参照できない (docs/01 §1.2 の結合順)。 */
  var TILE_KEY = null;
  function tileKey() {
    if (!TILE_KEY) {
      TILE_KEY = {};
      TILE_KEY[World.TILE.WALL] = 'wall';
      TILE_KEY[World.TILE.FLOOR] = 'floor';
      TILE_KEY[World.TILE.DOOR] = 'door';
    }
    return TILE_KEY;
  }

  /* ---------- 表示 ---------- */

  /** 星系マップに出す1行ぶんの情報。 */
  function summary(W, site) {
    var reached = deepestIn(W, site.id);
    var adapted = site.adaptation && hasAdaptation(W, site.adaptation);
    return {
      id: site.id,
      name: site.name,
      range: site.depthMin + '〜' + site.depthMax,
      reached: reached,
      cleared: !!adapted,
      adaptation: site.adaptation ? ADAPTATION_NAME[site.adaptation] : null,
      desc: site.desc,
      // 到達最深度から次に降りる深度を決める。初回はそのサイトの最浅部。
      nextDepth: Math.max(site.depthMin, Math.min(site.depthMax, reached || site.depthMin)),
      locked: lockReason(W, site)
    };
  }

  /**
   * 入れない理由。無ければ null。
   * 《起源》だけは4つの《適合》が揃うまで入れない (docs/07 §7.2)。
   */
  function lockReason(W, site) {
    if (site.id !== 'origin') return null;
    var have = adaptationCount(W);
    if (have >= 4) return null;
    return '《適合》が ' + have + '/4。4つ揃わないと留まれない。';
  }

  return {
    all: all, byId: byId, starting: starting, availableAt: availableAt,
    createProgress: createProgress, noteDepth: noteDepth, deepestIn: deepestIn,
    hasAdaptation: hasAdaptation, grantAdaptation: grantAdaptation,
    adaptationCount: adaptationCount, ADAPTATION_NAME: ADAPTATION_NAME,
    genOpts: genOpts, pickMonster: pickMonster, maxWeight: maxWeight,
    tileGlyph: tileGlyph, summary: summary, lockReason: lockReason
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Site;
