/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* sigil.js — 刻印とルーン式鑑定 (docs/02 §2.8)。DOM 非依存。
 *
 * 装備の性質は刻印(sigil)に分解される。
 * **刻印を1つ知ると、以後すべての装備でその刻印が既知になる。**
 * これが本作の鑑定 ([[D-06]])。総当たりの試行を無くし、知識が蓄積する形にする。
 */
'use strict';

var Sigil = (function () {

  /* ラン全体で共有する知識。W.knowledge に持つ。 */
  function createKnowledge() {
    return {
      sigils: {},     // id -> true (既知の刻印)
      kinds: {},      // itemKindId -> true (既知の消費アイテム種別)
      flavors: null   // base -> { kindId: flavorText } (ランごとにシャッフル)
    };
  }

  /**
   * フレーバーをランごとにシャッフルして割り当てる (docs/02 §2.8)。
   * 「濁ったアンプル」が何かは毎回変わる。
   */
  function assignFlavors(rng, raw) {
    var db = Data.get();
    var out = {};
    for (var base in raw) {
      if (base.charAt(0) === '_') continue;
      var pool = rng.shuffle(raw[base].slice());
      var kinds = db.items.filter(function (k) { return k.base === base; });
      var map = {};
      for (var i = 0; i < kinds.length; i++) {
        map[kinds[i].id] = pool[i % pool.length];
      }
      out[base] = map;
    }
    return out;
  }

  function isKnownSigil(K, id) { return !!K.sigils[id]; }
  function learnSigil(W, id) {
    if (W.knowledge.sigils[id]) return false;
    W.knowledge.sigils[id] = true;
    var s = Data.get().sigilsById[id];
    if (s) World.msg(W, '刻印《' + s.name + '》を理解した。');
    return true;
  }

  function isKnownKind(K, kindId) { return !!K.kinds[kindId]; }
  function learnKind(W, kindId) {
    if (W.knowledge.kinds[kindId]) return false;
    W.knowledge.kinds[kindId] = true;
    return true;
  }

  /** アイテムの刻印が全て既知か。 */
  function fullyKnown(K, it) {
    var list = it.sigils || [];
    for (var i = 0; i < list.length; i++) {
      if (!K.sigils[list[i]]) return false;
    }
    return true;
  }

  /**
   * 判明の経路 (docs/02 §2.8 の表)。
   * @param when 'wear' | 'hit' | 'hurt' | 'analyze'
   * @param opts { element } 被弾時の属性など、条件付きの刻印を絞る材料
   */
  function reveal(W, it, when, opts) {
    if (!it || !it.sigils) return 0;
    var db = Data.get();
    var learned = 0;
    for (var i = 0; i < it.sigils.length; i++) {
      var id = it.sigils[i];
      if (W.knowledge.sigils[id]) continue;
      var s = db.sigilsById[id];
      if (!s) continue;
      if (when !== 'analyze' && s.learn !== when) continue;
      // 耐性は「その属性で殴られたとき」に限る
      if (when === 'hurt' && s.kind === 'resist' && opts && opts.element && s.element !== opts.element) continue;
      // 特効は「その系統を殴ったとき」に限る
      if (when === 'hit' && s.kind === 'slay' && opts && opts.base && s.base !== opts.base) continue;
      if (learnSigil(W, id)) learned++;
    }
    if (learned && fullyKnown(W.knowledge, it)) {
      World.msg(W, name(W.knowledge, it) + 'の解析が完了した。');
    }
    return learned;
  }

  /** 解析(母船・プロトコル)。全ての刻印を一度に既知にする。 */
  function analyze(W, it) {
    var n = reveal(W, it, 'analyze');
    learnKind(W, it.kindId);
    it.analyzed = true;
    return n;
  }

  /**
   * 表示名を組み立てる。
   * - 未知の刻印が残っていれば「未解析の〜」
   * - 消費アイテムで種別が未知ならフレーバー名
   */
  function name(K, it) {
    var db = Data.get();

    // 消費アイテム: 種別を知らなければフレーバーで呼ぶ
    if (!it.slot && K.flavors && K.flavors[it.base] && !K.kinds[it.kindId]) {
      var f = K.flavors[it.base][it.kindId];
      if (f) {
        var baseName = db.itemBase[it.base].name;
        return f + baseName;
      }
    }

    var s = '';
    if (it.uniqueId) {
      // 固有機材は名前そのものが固有。刻印が未知なら伏せる。
      s = fullyKnown(K, it) ? it.name : '未解析の' + db.itemBase[it.base].name;
      return s;
    }

    s = it.name;
    if (it.egoName) {
      if (fullyKnown(K, it)) s = it.egoName + 'の' + s;
      else return '未解析の' + s;
    }
    // 数値ボーナスは刻印を伴わないので、装備すれば分かる
    if (it.known && (it.toHit || it.toDam)) {
      s += ' (' + fmt(it.toHit) + ',' + fmt(it.toDam) + ')';
    }
    if (it.known && it.ac) s += ' [' + it.ac + ']';
    return s;
  }

  function fmt(n) { n = n || 0; return (n >= 0 ? '+' : '') + n; }

  /**
   * 装備の刻印から効果を集計する。
   * 未知の刻印も**効果は発揮する**(知らないだけで効いている — 本家準拠)。
   */
  function collect(sigilIds, pval) {
    var db = Data.get();
    var out = {
      stats: { str: 0, int: 0, wis: 0, dex: 0, con: 0, chr: 0 },
      resist: {}, brand: [], slay: [],
      speed: 0, seal: 0, light: 0, regen: 0, stealth: 0, efficiency: 0,
      freeAction: false, seeInvisible: false,
      drain: 0, fragile: 0, hunger: 0, noise: 0
    };
    for (var i = 0; i < sigilIds.length; i++) {
      var s = db.sigilsById[sigilIds[i]];
      if (!s) continue;
      var n = pval || 1;
      if (s.kind === 'stat') out.stats[s.stat] += (s.taint ? -n : n);
      else if (s.kind === 'resist') out.resist[s.element] = true;
      else if (s.kind === 'brand') out.brand.push(s.element);
      else if (s.kind === 'slay') out.slay.push({ base: s.base, mult: s.mult });
      else if (s.kind === 'misc') {
        var attr = s.attr;
        if (attr === 'freeAction') out.freeAction = true;
        else if (attr === 'seeInvisible') out.seeInvisible = true;
        else if (attr in out) out[attr] += (s.taint ? -n : n);
      }
    }
    return out;
  }

  return {
    createKnowledge: createKnowledge, assignFlavors: assignFlavors,
    isKnownSigil: isKnownSigil, learnSigil: learnSigil,
    isKnownKind: isKnownKind, learnKind: learnKind,
    fullyKnown: fullyKnown, reveal: reveal, analyze: analyze,
    name: name, collect: collect
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Sigil;
