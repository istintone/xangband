/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* env.js — 惑星環境。docs/08。DOM 非依存。
 *
 * 階層は7つの環境値を持ち、それぞれが「特定の装備を要求する」形で作用する ([[D-46]])。
 * ダメージ源としてではなく、**装備の選択を強制するもの**として設計する。
 *
 * 環境はサイトごとに固定する。毎階ランダムにしない ―
 * 「このサイトはこういう場所だ」と学習できることが重要 (docs/08 §8.10)。
 */
'use strict';

var Env = (function () {

  /* 標準環境。母船と、サイト定義が無い場合の既定値。 */
  var NORMAL = {
    atmosphere: 100,    // 気圧。100 が標準大気
    temperature: 20,    // 温度(摂氏相当)
    radiation: 0,       // 放射線量 0..10
    contamination: 0,   // 生体汚染 0..10
    gravity: 1.0,       // 重力。1.0 が標準
    surveillance: 0,    // 監視密度 0..10
    ambient: 1          // 環境光 0..3。0 = 完全暗黒
  };

  function create(overrides) {
    var e = {};
    for (var k in NORMAL) e[k] = NORMAL[k];
    if (overrides) for (var k2 in overrides) if (k2 in e) e[k2] = overrides[k2];
    return e;
  }

  /* ---------- 気密 (docs/08 §8.4) ---------- */

  /** その気圧で必要な気密値。気圧60以上なら 0。 */
  function sealRequired(env) {
    if (!env || env.atmosphere >= 60) return 0;
    return Math.ceil((60 - env.atmosphere) / 15);
  }

  /** 不足している気密。0 なら問題なし。 */
  function sealDeficit(W) {
    if (adapted(W, 'vacuum')) return 0;
    var need = sealRequired(envOf(W));
    return Math.max(0, need - (W.player.seal || 0));
  }

  /** 減圧下では精神系・生体系の能力が使えない (発声を伴うため)。 */
  function canUseSystem(W, system) {
    if (system === 'machine' || !system) return true;
    return sealDeficit(W) === 0;
  }

  /** 現在階の環境。未設定なら標準。 */
  function envOf(W) {
    return (W.level && W.level.env) || NORMAL;
  }

  /* ---------- 重力 (docs/08 §8.3) ---------- */

  /**
   * 重力による速度補正。低重力は速く、高重力は遅い。
   *
   * **10きざみでしか動かさない** ([[D-91]])。
   * エネルギー表は 109→5 / 110→10 の段差を意図して持っている
   * ([[doc:core]] §2.1) ―― 本家では速度が10きざみでしか変わらないので
   * この段差は「減速呪文を食らったら半減」という意味になる。
   * ところが重力は**常時かかる環境の性質**なので、-1 のつもりの補正が
   * そのまま段差を踏み抜く。実際、遺跡(1.1G)は速度109 = 行動回数半減で、
   * **深度60の関門が深度100より難しい**主因になっていた。
   *
   * しかも表には**緩やかな減速帯が無い** ―― 109 で 0.5倍、100 で 0.3倍。
   * つまり常時かかる環境が速度を下げると、それは調整つまみではなく壁になる。
   * だから**重力は速度を上げるだけ**にした。高重力は近接ダメージと積載で効く。
   * 一時的な `slow` は今までどおり段差を踏む ―― そちらは踏ませたい効果。
   */
  function speedMod(env) {
    var g = env.gravity;
    if (g <= 0.8) return 10;          // 方舟(0.3G)。唯一「有利になる」環境
    if (g < 1.8) return 0;            // 遺跡1.1G / 《起源》1.4G。速度は下げない
    return -10;                       // 極端な重力だけ。現状どのサイトも該当しない
  }

  /** 重力による近接ダメージ補正(%)。低重力は踏ん張れない。 */
  function meleeMod(env) {
    var g = env.gravity;
    if (g >= 0.95 && g <= 1.05) return 100;
    return U.clamp(Math.round(60 + g * 40), 40, 160);
  }

  /** 重力による積載上限の倍率。 */
  function carryMod(env) {
    var g = env.gravity;
    if (g >= 0.95 && g <= 1.05) return 1.0;
    return U.clamp(1.4 - g * 0.4, 0.4, 2.0);
  }

  /* ---------- 遮蔽 (灰の地表: 被曝を止める) ---------- */

  /**
   * その座標が遮蔽されているか。上下左右のいずれかが壁なら陰とみなす。
   * 開けた場所ほど被曝する ―「地形の裏を伝って進む」を成立させる。
   */
  function isSheltered(lv, x, y) {
    for (var i = 0; i < U.ORTHO.length; i++) {
      if (World.blocksSight(lv, x + U.ORTHO[i].dx, y + U.ORTHO[i].dy)) return true;
    }
    return false;
  }

  /* ---------- 毎ゲームターンの作用 ---------- */

  /**
   * 環境がプレイヤーに与える影響を1ゲームターンぶん解決する。
   * cmd.js の upkeep から呼ぶ。
   * @returns {object} { damage, causes[] } 何が効いたか(表示と統計用)
   */
  function tick(W) {
    var p = W.player;
    var env = envOf(W);
    var res = { damage: 0, causes: [] };
    if (p.dead) return res;

    // --- 減圧 ---
    // 《適合:真空》を得ていれば減圧は効かない (docs/07 §7.2)
    var deficit = adapted(W, 'vacuum') ? 0 : sealDeficit(W);
    if (deficit > 0) {
      // 減圧だけは「装備が無ければ進めない」という信号なので、
      // 他の環境と違って明確に致死的にする。ただし完全に予防可能 ([[D-54]] の例外)。
      if (W.turn % 3 === 0) {
        var dmg = deficit * (1 + Math.floor(W.depth / 15));
        res.damage += dmg;
        res.causes.push('減圧');
        W.lastAttacker = '減圧';
        Actor.damage(p, dmg);
        if (W.turn % 15 === 0) World.msg(W, '気密が保てない。ここには居られない。');
      }
    }

    // --- 温度。遮蔽されていれば効かない (建物の中・岩陰) ---
    // 「凌げる場所がある」ことが設計の要 ([[D-54]])。歩き続ける代償として払わせる。
    var sheltered = isSheltered(W.level, p.x, p.y);
    if (!sheltered) {
      var over = 0, label = null, element = null;
      if (env.temperature >= HEAT_THRESHOLD) {
        over = env.temperature - HEAT_THRESHOLD; label = '高熱'; element = 'fire';
      } else if (env.temperature <= COLD_THRESHOLD) {
        over = COLD_THRESHOLD - env.temperature; label = '凍結'; element = 'cold';
      }
      if (label && !resist(p, element)) {
        // 極端なほど頻度が上がるが、下限 12ターンより速くはならない
        var tperiod = Math.max(12, 30 - Math.floor(over / 4));
        if (W.turn % tperiod === 0) {
          var tdmg = 1 + Math.floor(over / 60) + Math.floor(W.depth / 15);
          res.damage += tdmg; res.causes.push(label);
          W.lastAttacker = label;
          Actor.damage(p, tdmg);
          if (W.turn % (tperiod * 6) === 0) {
            World.msg(W, label === '高熱' ? '暑い。遮蔽物の陰に入りたい。'
                                          : '寒い。遮蔽物の陰に入りたい。');
          }
        }
      }
    }

    // --- 放射線。遮蔽物の陰なら大きく減る。《適合:放射》で無効 ---
    // 較正 ([[D-54]]): 1階層の滞在(約3000ゲームターン)で被曝 25〜30。
    // EXPOSURE_STEP(25) と釣り合わせ、「1階潜るごとに能力値1つが落ちる」圧にする。
    if (env.radiation > 0 && !resist(p, 'rad') && !Player.hasFlag(p, 'NO_RAD') &&
        !adapted(W, 'radiation')) {
      var rate = sheltered ? 4 : 1;                        // 陰なら 1/4 の頻度
      var period = Math.max(30, Math.floor(900 / env.radiation)) * rate;
      if (W.turn % period === 0) {
        p.exposure = (p.exposure || 0) + 1;
        res.causes.push('被曝');
        checkExposure(W, p);
      }
    }

    // --- 生体汚染。空気なので遮蔽物は効かない ---
    // 較正: 1階層で 20 前後。CONTAMINATION_STEP(30) なので変異は 1.5階に1回程度。
    if (env.contamination > 0 && !resist(p, 'pois') && !Player.hasFlag(p, 'NO_POISON') &&
        !adapted(W, 'contamination')) {
      var cperiod = Math.max(40, Math.floor(1200 / env.contamination));
      if (W.turn % cperiod === 0) {
        p.contamination = (p.contamination || 0) + 1;
        res.causes.push('汚染');
        checkContamination(W, p);
      }
    }

    if (W.tally) W.tally.env += res.damage;         // [[D-53]] の指標
    return res;
  }

  /* 温度の閾値。これを超えた分だけが効く。 */
  var HEAT_THRESHOLD = 55;
  var COLD_THRESHOLD = -25;

  /** 《適合》を得ているか。Site が読み込まれていない場合も考慮する。 */
  function adapted(W, kind) {
    return typeof Site !== 'undefined' && Site.hasAdaptation(W, kind);
  }

  function resist(p, element) {
    return !!(p.equipBonus && p.equipBonus.resist && p.equipBonus.resist[element]);
  }

  /* 被曝の閾値。超えるごとに能力値が一時低下する (母船で治療できる)。 */
  var EXPOSURE_STEP = 25;

  function checkExposure(W, p) {
    if (p.exposure > 0 && p.exposure % EXPOSURE_STEP === 0) {
      var key = W.rng.pick(['str', 'dex', 'con']);
      Stat.drain(p, key, 1);
      World.msg(W, '被曝が身体を蝕んでいる。' + Effect.STAT_NAME[key] + 'が落ちた。');
    } else if (p.exposure === Math.floor(EXPOSURE_STEP / 2)) {
      World.msg(W, '計器が鳴っている。被曝が進んでいる。');
    }
  }

  /* 汚染の閾値。超えると変異する。利点と欠点が半々 ([[D-07]] と同じ思想)。 */
  var CONTAMINATION_STEP = 30;

  var MUTATIONS = [
    { id: 'thick-hide', name: '硬化皮膚', good: true,
      apply: function (W, p) { p.mutationAC = (p.mutationAC || 0) + 4; },
      desc: 'AC が上がった。' },
    { id: 'dense-tissue', name: '緻密組織', good: true,
      apply: function (W, p) { p.hpMax += 8; p.hp += 8; },
      desc: '体力の上限が上がった。' },
    { id: 'photo-eye', name: '感光眼', good: true,
      apply: function (W, p) { p.infra = (p.infra || 0) + 1; },
      desc: '暗いところが見えるようになった。' },
    { id: 'brittle-bone', name: '骨の脆化', good: false,
      apply: function (W, p) { p.mutationAC = (p.mutationAC || 0) - 3; },
      desc: 'AC が下がった。' },
    { id: 'metabolic-burn', name: '代謝暴走', good: false,
      apply: function (W, p) { p.mutationHunger = true; },
      desc: '消耗が速くなった。' },
    { id: 'nerve-noise', name: '神経雑音', good: false,
      apply: function (W, p) { Stat.drain(p, 'dex', 1); },
      desc: '反射が鈍くなった。' }
  ];

  function checkContamination(W, p) {
    if (p.contamination <= 0 || p.contamination % CONTAMINATION_STEP !== 0) {
      if (p.contamination === Math.floor(CONTAMINATION_STEP / 2)) {
        World.msg(W, '皮膚の下で何かが動いている。');
      }
      return;
    }
    if (!p.mutations) p.mutations = [];
    var m = W.rng.pick(MUTATIONS);
    p.mutations.push(m.id);
    m.apply(W, p);
    World.msg(W, '変異した ―― 《' + m.name + '》。' + m.desc);
  }

  /* ---------- 表示 ---------- */

  /** 入階時に環境を一言で告げる。安全なら何も言わない。 */
  function describe(W) {
    var env = envOf(W);
    var out = [];
    var need = sealRequired(env);
    if (env.atmosphere <= 5) out.push('真空だ。');
    else if (need >= 3) out.push('ほとんど空気が無い。');
    else if (need >= 1) out.push('気圧が低い。');

    if (env.ambient === 0) out.push('完全な闇だ。');
    if (env.radiation >= 6) out.push('計器が振り切れている。');
    else if (env.radiation >= 3) out.push('線量計が鳴っている。');
    if (env.contamination >= 6) out.push('空気が生臭い。');
    if (env.temperature >= 60) out.push('焼けるように暑い。');
    if (env.temperature <= -20) out.push('凍てついている。');
    if (env.gravity <= 0.5) out.push('身体が軽い。');
    if (env.gravity >= 1.5) out.push('身体が重い。');
    if (env.surveillance >= 6) out.push('見られている。');
    return out.join(' ');
  }

  /** サイドバーに出す「危険な環境値だけ」のリスト。 */
  function warnings(W) {
    var p = W.player, env = envOf(W), out = [];
    var need = sealRequired(env);
    if (need > 0) {
      out.push({ label: '気密', value: (p.seal || 0) + '/' + need,
                 color: (p.seal || 0) < need ? 'red' : 'cyan' });
    }
    if (p.exposure > 0) {
      out.push({ label: '被曝', value: String(p.exposure),
                 color: p.exposure >= EXPOSURE_STEP ? 'red' : 'yellow' });
    }
    if (p.contamination > 0) {
      out.push({ label: '汚染', value: String(p.contamination),
                 color: p.contamination >= CONTAMINATION_STEP ? 'magenta' : 'yellow' });
    }
    if (env.surveillance >= 3 && W.alerted) {
      out.push({ label: '補足', value: '!', color: 'red' });
    }
    return out;
  }

  return {
    NORMAL: NORMAL, MUTATIONS: MUTATIONS,
    EXPOSURE_STEP: EXPOSURE_STEP, CONTAMINATION_STEP: CONTAMINATION_STEP,
    HEAT_THRESHOLD: HEAT_THRESHOLD, COLD_THRESHOLD: COLD_THRESHOLD,
    create: create, envOf: envOf,
    sealRequired: sealRequired, sealDeficit: sealDeficit, canUseSystem: canUseSystem,
    speedMod: speedMod, meleeMod: meleeMod, carryMod: carryMod,
    isSheltered: isSheltered, adapted: adapted,
    tick: tick, describe: describe, warnings: warnings
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Env;
