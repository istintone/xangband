/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* craft.js — 解体と移植。docs/11 §11.4 ([[doc:concept]] §0.4(4))。DOM 非依存。
 *
 * 本家は「エゴ品/固有品は拾うもの」。本作は**拾ったジャンクを解体・移植**できる。
 *
 * 狙いは「弱いが好きな装備を育てられる」ことであって、
 * 最強装備を組み立てる工房ではない。だから:
 *
 *   - 素の装備からは何も取れない。**改修品(エゴ)を解体したときだけ**刻印が取れる
 *     → 今まで売るしかなかった「弱いエゴ品」に価値が生まれる
 *   - 移植は**2枠まで**。全部載せが最適解になると選択が消える
 *   - 移植は失敗しない。**緊張は素材の希少さで作る**
 */
'use strict';

var Craft = (function () {

  /** 1つの装備に移植できるモジュールの数 (docs/11 §11.4)。 */
  var MAX_MODULES = 2;

  /** モジュールの表示名。語彙は刻印と同じものを使う (新しい語を増やさない)。 */
  function sigilLabel(id) {
    var s = Data.get().sigilsById[id];
    return s ? s.name : id;
  }

  /* ---------- 解体 ---------- */

  /** 解体して何が取れるか。取れないなら null。 */
  function salvageYield(it) {
    if (!it || !it.slot) return null;                 // 装備でないものは解体しない
    if (it.uniqueId) return null;                     // 固有機材は壊させない
    var sigils = (it.sigils || []).filter(function (s) { return s.charAt(0) === 's'; });
    if (!it.egoId || !sigils.length) return null;     // 素の装備からは取れない
    return sigils[0];
  }

  /** 解体できない理由。できるなら null。 */
  function salvageReason(W, it) {
    if (!it) return 'その品は無い。';
    if (!it.slot) return '装備品でないものは解体できない。';
    if (it.uniqueId) return 'これは分解できない。';
    if (!it.known) return '解析していないものは解体できない。';
    if (!salvageYield(it)) return '取り出せるものが無い。改修品でないと何も残らない。';
    return null;
  }

  /**
   * 解体する。装備は**戻らない**。
   * @returns {object} { ok, sigil, reason }
   */
  function salvage(W, it) {
    var why = salvageReason(W, it);
    if (why) return { ok: false, reason: why };

    var sig = salvageYield(it);
    Inventory.remove(W.inv, it);
    addModule(W, sig);
    World.msg(W, Sigil.name(W.knowledge, it) + 'を解体した。');
    World.msg(W, '《' + sigilLabel(sig) + '》のモジュールを取り出した。');
    return { ok: true, sigil: sig };
  }

  /* ---------- モジュールの手持ち ---------- */

  function modules(W) {
    if (!W.modules) W.modules = {};
    return W.modules;
  }

  function addModule(W, sigilId) {
    var m = modules(W);
    m[sigilId] = (m[sigilId] || 0) + 1;
  }

  function moduleList(W) {
    var m = modules(W), out = [];
    for (var k in m) if (m[k] > 0) out.push({ sigil: k, count: m[k] });
    out.sort(function (a, b) { return a.sigil < b.sigil ? -1 : 1; });
    return out;
  }

  /* ---------- 移植 ---------- */

  /**
   * 移植に要るレアパーツの数 (docs/11 §11.4)。
   * 深いほど高くつく。供給過多にしないための制約。
   */
  function partsNeeded(W, it) {
    var depth = Math.max(1, W.player.depthMax);
    return 1 + Math.floor(depth / 25);
  }

  function parts(W) { return W.parts || 0; }

  function addParts(W, n) { W.parts = parts(W) + n; }

  /** 移植できない理由。できるなら null。 */
  function transplantReason(W, it, sigilId) {
    if (!it) return 'その品は無い。';
    if (!it.slot) return '装備品にしか移植できない。';
    if (it.uniqueId) return '固有機材には手を入れられない。';
    if (!it.known) return '解析していないものには移植できない。';
    if (!modules(W)[sigilId]) return 'そのモジュールを持っていない。';
    if ((it.sigils || []).indexOf(sigilId) !== -1) return '既に同じ刻印が入っている。';
    if (grafted(it) >= MAX_MODULES) {
      return 'これ以上は入らない。(' + MAX_MODULES + '枠まで)';
    }
    if (parts(W) < partsNeeded(W, it)) {
      return 'レアパーツが足りない。(' + parts(W) + '/' + partsNeeded(W, it) + ')';
    }
    return null;
  }

  /** その装備に移植済みのモジュール数。元から付いていた刻印は数えない。 */
  function grafted(it) { return (it.grafted || []).length; }

  /**
   * 移植する。**失敗しない。**
   * @returns {object} { ok, reason }
   */
  function transplant(W, it, sigilId) {
    var why = transplantReason(W, it, sigilId);
    if (why) return { ok: false, reason: why };

    var need = partsNeeded(W, it);
    W.parts = parts(W) - need;
    modules(W)[sigilId]--;

    if (!it.sigils) it.sigils = [];
    it.sigils.push(sigilId);
    if (!it.grafted) it.grafted = [];
    it.grafted.push(sigilId);

    // 移植した装備は改修品として扱う。名前にもそれが出る
    if (!it.egoId) {
      it.egoId = 'e-grafted';
      it.egoName = '改造';
    }
    Sigil.learnSigil(W, sigilId);
    World.msg(W, Sigil.name(W.knowledge, it) + 'に《' + sigilLabel(sigilId) + '》を移植した。');
    return { ok: true };
  }

  return {
    MAX_MODULES: MAX_MODULES, sigilLabel: sigilLabel,
    salvageYield: salvageYield, salvageReason: salvageReason, salvage: salvage,
    modules: modules, addModule: addModule, moduleList: moduleList,
    partsNeeded: partsNeeded, parts: parts, addParts: addParts,
    transplantReason: transplantReason, transplant: transplant, grafted: grafted
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Craft;
