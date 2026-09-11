/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* save.js — localStorage への永続化。shell 層 (ブラウザAPIを触る)。
 *
 * 状態 <-> プレーンオブジェクトの変換は world.js (rule層) が持つ。
 * ここは保存先とのやり取りだけなので、ヘッドレステストは world.js 側で書ける。
 *
 * docs/01 §1.4:
 *   - パーマデス: 死亡でセーブを破棄し、墓碑だけを別キーに残す
 *   - セーブスカム対策: 乱数状態を保存に含める (world.serialize が入れている)
 */
'use strict';

var Save = (function () {

  var KEY = 'xangband.save';
  var SCORES = 'xangband.scores';

  function available() {
    try {
      localStorage.setItem('xangband.probe', '1');
      localStorage.removeItem('xangband.probe');
      return true;
    } catch (e) { return false; }
  }

  function save(W) {
    if (!available()) return { ok: false, reason: '保存先が使えない。' };
    try {
      localStorage.setItem(KEY, JSON.stringify(World.serialize(W)));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: '保存に失敗した: ' + e.message };
    }
  }

  function hasSave() {
    try { return !!localStorage.getItem(KEY); } catch (e) { return false; }
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return { ok: false, reason: 'セーブが無い。' };
      return { ok: true, world: World.deserialize(JSON.parse(raw)) };
    } catch (e) {
      return { ok: false, reason: 'セーブを読めない: ' + e.message };
    }
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) { /* 保存先が無くても続行する */ }
  }

  /** 死亡時: セーブを破棄し、墓碑をスコア一覧に積む (パーマデス)。 */
  function recordDeath(W) {
    clear();
    record(W);
  }

  /**
   * 勝利時: 勝っても続かない (パーマデス — [[doc:endgame]] §7.5)。
   * セーブは同じように破棄し、記録に「勝者」として残す。
   */
  function recordVictory(W) {
    clear();
    record(W);
  }

  function record(W) {
    // 開発用起動で始めたランは記録しない ([[D-66]])。記録の意味が壊れる
    if (W.devRun) return;
    try {
      var list = JSON.parse(localStorage.getItem(SCORES) || '[]');
      list.push(W.grave);
      // 勝者を先頭に。その中では到達深度順
      list.sort(function (a, b) {
        if (!!b.won !== !!a.won) return b.won ? 1 : -1;
        return (b.depthMax || 0) - (a.depthMax || 0);
      });
      localStorage.setItem(SCORES, JSON.stringify(list.slice(0, 50)));
    } catch (e) { /* スコアが残せなくてもゲームは続けられる */ }
  }

  function scores() {
    try { return JSON.parse(localStorage.getItem(SCORES) || '[]'); } catch (e) { return []; }
  }

  return {
    KEY: KEY, available: available,
    save: save, load: load, hasSave: hasSave, clear: clear,
    recordDeath: recordDeath, recordVictory: recordVictory, scores: scores
  };
})();
