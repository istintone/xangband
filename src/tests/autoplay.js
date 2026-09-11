/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* autoplay.js — ヘッドレス自動プレイ (モンキーテスト)。
 *
 * M1 の受け入れ基準「1000回のランダム自動プレイでクラッシュ0」を測る。
 * cmd.js / turn.js が rule 層にある ([[D-28]]) ので、DOM 無しで最後まで駆動できる。
 *
 *   node src/tests/autoplay.js              既定 200 ラン
 *   node src/tests/autoplay.js --runs 1000  受け入れ基準の本番
 *   node src/tests/autoplay.js --seed foo --verbose   1ランを追う
 *   node src/tests/autoplay.js --site ark            サイトを固定して測る
 *   node src/tests/autoplay.js --metrics --runs 60   4サイトを回して [[D-53]] を判定
 */
'use strict';
const { load } = require('./_setup');

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i !== -1 ? argv[i + 1] : def;
};
const RUNS = parseInt(arg('runs', '200'), 10);
const MAX_STEPS = parseInt(arg('steps', '3000'), 10);
const VERBOSE = argv.includes('--verbose');
const FIXED_SEED = arg('seed', null);
let SITE_OVERRIDE = null;
const SITE_ARG = arg('site', null);       // 降下先を固定する (サイト別の測定用)
const METRICS = argv.includes('--metrics');
const SITE = { get id() { return SITE_OVERRIDE || SITE_ARG; } };

const ctx = load();
const { RNG, World, Cmd, Data, Inventory, Item, Turn, U, Ability, Sigil, Hub, Stat,
        Env, Site, Player, Signature, Net } = ctx;
Data.init(ctx.RAW);

/** 全ての系統×ロールを均等に回す。特定の組み合わせだけ検査しないため。 */
const COMBOS = [];
for (const lin of Data.get().lineages) {
  for (const role of Data.get().roles) COMBOS.push([lin.id, role.id]);
}

/**
 * 素朴な自動プレイヤー。賢くはないが、ゲームの全経路を叩くことを狙う。
 * 完全ランダムだと戦闘・成長・降下にほとんど到達せず、
 * 「クラッシュしないが何も検査していない」テストになるため、
 * 交戦と階段への移動には明確なバイアスをかける。
 */
function decide(W, rng) {
  const p = W.player;

  // 瀕死なら回復アイテムを使う
  if (p.hp * 3 < p.hpMax) {
    const heal = W.inv.items.find(it => it.effect && it.effect.indexOf('heal') === 0);
    if (heal) return { type: 'use', item: heal };
  }
  // 腹が減ったら食べる
  if (p.food < 300) {
    const food = W.inv.items.find(it => it.effect && it.effect.indexOf('feed') === 0);
    if (food) return { type: 'use', item: food };
  }
  // 電力が切れたら装填する
  if (p.cells < 20) {
    const cell = W.inv.items.find(it => it.effect && it.effect.indexOf('cell') === 0);
    if (cell) return { type: 'use', item: cell };
  }

  // 母船にいるなら、買い物をしてから降りる
  if (W.depth === 0) return decideInHub(W, rng);

  // 隣接する敵と交戦する。瀕死なら離れる。
  const foe = adjacentFoe(W);
  if (foe) {
    if (p.hp * 4 < p.hpMax && rng.chance(0.6)) {
      const away = stepAwayFrom(W, foe.x, foe.y, rng);
      if (away) return { type: 'move', dx: away[0], dy: away[1] };
    }
    return { type: 'move', dx: Math.sign(foe.x - p.x), dy: Math.sign(foe.y - p.y) };
  }

  const seen = visibleFoe(W);

  /* 能力を使う。SP が余っているほど積極的に使う ―― 抱えたまま死ぬのが一番損。
     能力系ロールの火力はここにあるので、使わないと素手で殴る役になる。 */
  if (seen && p.abilities.length && p.sp > 0) {
    const ratio = p.spMax > 0 ? p.sp / p.spMax : 0;
    if (ratio > 0.5 || rng.chance(ratio)) {
      return { type: 'ability', id: rng.pick(p.abilities) };
    }
  }
  // 遠隔攻撃 (射出器のコードを叩く)
  if (seen && W.inv.equip.launcher && rng.oneIn(3)) {
    return { type: 'shoot', target: seen };
  }

  // 見えている敵へ寄る (交戦を発生させる)
  if (seen && rng.chance(0.7)) {
    const s = stepPathTo(W, seen.x, seen.y);
    if (s) return { type: 'move', dx: s[0], dy: s[1] };
  }

  /* 端末に接続する (docs/11 §11.3)。接続者の identity はここにあるので、
     使わずに測ると「HP の低い突撃兵」を測っていることになる。 */
  if (typeof Net !== 'undefined' && Net.atTerminal(W)) {
    for (const e of Net.listFor(W)) {
      if (e.blocked || p.cog < e.op.cost) continue;
      if (Net.chance(W, e.op) < 40) continue;          // 分の悪い賭けはしない
      return { type: 'jack', id: e.op.id };
    }
  }
  // 端末が無ければ、接続者は自分で立てる
  if (typeof Net !== 'undefined' && !Net.atTerminal(W) &&
      p.abilities.indexOf('field-jack') !== -1 && p.sp >= 4 && p.cog > 4 &&
      World.getTile(W.level, p.x, p.y) === World.TILE.FLOOR && rng.oneIn(60)) {
    return { type: 'ability', id: 'field-jack' };
  }

  // 足元に物があれば拾う
  if (Item.itemsAt(W, p.x, p.y).length > 0) return { type: 'pickup' };

  // 見えている床のアイテムへ寄り道する。これが無いと階段に直行してしまい、
  // 拾得・装備・鑑定(刻印)の経路が一度も叩かれない。
  if (rng.chance(0.6)) {
    let best = null, bd = 99;
    for (const it of W.items) {
      if (!World.hasFlag(W.level, it.x, it.y, World.F.KNOWN)) continue;
      const d = U.distCheb(it.x, it.y, p.x, p.y);
      if (d < bd) { bd = d; best = it; }
    }
    if (best) {
      const s = stepPathTo(W, best.x, best.y);
      if (s) return { type: 'move', dx: s[0], dy: s[1] };
    }
  }
  // 装備できるものは装備してみる。改修品/固有機材を優先し、
  // ルーン式鑑定(刻印の判明)の経路を確実に叩く。
  const special = W.inv.items.find(it => it.slot && (it.egoId || it.uniqueId));
  if (special) return { type: 'equip', item: special };
  if (rng.oneIn(15)) {
    const wearable = W.inv.items.find(it => it.slot);
    if (wearable) return { type: 'equip', item: wearable };
  }
  // たまに使う・落とす・外す (異常系を叩く)
  if (rng.oneIn(50) && W.inv.items.length) {
    const it = rng.pick(W.inv.items);
    return rng.chance(0.5) ? { type: 'use', item: it } : { type: 'drop', item: it };
  }
  if (rng.oneIn(300)) {
    const slot = rng.pick(Inventory.SLOTS);
    return { type: 'unequip', slot };
  }
  if (rng.oneIn(400)) return { type: 'light' };
  /* 能力の習得。**覚えられるなら即座に覚える。**
     1/40 の抽選にしていたので、レベル6 で4つ覚えられるロールが1つしか持たず、
     測定がロールの設計ではなく測定器の怠慢を映していた ([[Q-20]])。 */
  if (p.system && Ability.canLearnMore(p)) {
    const pool = Ability.learnable(p);
    if (pool.length) Ability.learn(W, p, pool[pool.length - 1].id);   // 深いものから
  }

  // 撤退。理由があるうちは上へ向かう ([[D-53]])
  const why = retreatReason(W);
  if (why) {
    W.retreatWhy = why;
    /* 監視は**階を移れば切れる**。上に戻る必要は無く、先へ進めばよい。
       尖塔の「戦って解決できない圧」は前進で払う設計なので、
       ここを上りに固定すると尖塔を一度も踏破できない。 */
    const down = (why === '監視');
    const goal = down ? W.level.down : W.level.up;
    const here = World.getTile(W.level, p.x, p.y);
    if (here === (down ? World.TILE.DOWN : World.TILE.UP)) {
      return { type: down ? 'descend' : 'ascend' };
    }
    if (goal) {
      const s = stepPathTo(W, goal.x, goal.y);
      if (s) return { type: 'move', dx: s[0], dy: s[1] };
    }
  }

  // 階段の上なら降りる
  if (World.getTile(W.level, p.x, p.y) === World.TILE.DOWN) return { type: 'descend' };

  // 降下シャフトへ向かう。BFS で実際に辿り着けるようにする。
  // (「探索」の再現ではなく、深部のコードを叩くための移動)
  if (W.level.down && rng.chance(0.9)) {
    const s = stepPathTo(W, W.level.down.x, W.level.down.y);
    if (s) return { type: 'move', dx: s[0], dy: s[1] };
  }
  const d = rng.pick(U.DIRS);
  return { type: 'move', dx: d.dx, dy: d.dy };
}

/**
 * BFS で目標への次の1歩を返す。テスト専用 (ゲーム本体の敵AIは別物 — [[Q-13]])。
 * これが無いと自動プレイヤーは壁に張り付いたまま何も検査しない。
 */
function stepPathTo(W, tx, ty) {
  const lv = W.level;
  const p = W.player;
  if (p.x === tx && p.y === ty) return null;

  /* 呼吸できないマスは避ける。方舟の気圧は**避けられる**ダメージなので、
     素通りする自動プレイヤーで測ると「環境が理不尽」という数字しか出ない
     ([[D-62]] の測定)。回り道が無いときだけ踏む。 */
  const canBreathe = (x, y) => {
    if (!lv.pressure) return true;
    return W.player.seal >= Env.sealRequired({ atmosphere: Signature.pressureAt(W, x, y) });
  };
  const safe = passable(W, tx, ty, canBreathe);
  if (safe) return safe;

  return passable(W, tx, ty, () => true);
}

/** BFS 本体。ok(x,y) が false のマスは通らない。 */
function passable(W, tx, ty, ok) {
  const lv = W.level;
  const p = W.player;
  const prev = new Int32Array(lv.w * lv.h).fill(-1);
  const start = p.y * lv.w + p.x;
  const goal = ty * lv.w + tx;
  prev[start] = start;

  let queue = [start];
  let found = false;
  while (queue.length && !found) {
    const next = [];
    for (const cur of queue) {
      const cx = cur % lv.w, cy = (cur - cx) / lv.w;
      for (const d of ctx.U.DIRS) {
        const nx = cx + d.dx, ny = cy + d.dy;
        if (!World.inBounds(lv, nx, ny)) continue;
        const n = ny * lv.w + nx;
        if (prev[n] !== -1) continue;
        if (!World.walkable(lv, nx, ny)) continue;
        if (n !== goal && !ok(nx, ny)) continue;
        prev[n] = cur;
        if (n === goal) { found = true; break; }
        next.push(n);
      }
      if (found) break;
    }
    queue = next;
  }
  if (prev[goal] === -1) return null;

  // 目標から遡って、始点の次のマスを得る
  let node = goal;
  while (prev[node] !== start) {
    node = prev[node];
    if (node === start) return null;
  }
  const nx = node % lv.w, ny = (node - nx) / lv.w;
  return [nx - p.x, ny - p.y];
}

/**
 * 母船での行動。店で買い、装備し、降りる。
 * 深度0 のコード(店・格納庫・価格・降下)を実際に叩くために要る。
 */
function decideInHub(W, rng) {
  const p = W.player;
  const want = SITE.id;
  if (want && (!W.site || W.site.id !== want)) Cmd.selectSite(W, want);

  // 在庫を1つ買ってみる (価格と所持金の整合を叩く)
  if (rng.oneIn(3)) {
    const shop = rng.pick(Hub.SHOPS);
    const stock = (W.shops && W.shops[shop.id]) || [];
    if (stock.length) {
      const i = rng.int(stock.length);
      Hub.buy(W, shop.id, i);
    }
  }
  // 役務を試す
  if (rng.oneIn(20)) Hub.cureService(W);
  if (rng.oneIn(20)) Hub.repairService(W);
  // 格納庫に預けて取り出す
  if (rng.oneIn(15) && W.inv.items.length) Hub.store(W, rng.pick(W.inv.items));
  if (rng.oneIn(15) && W.home.length) Hub.retrieve(W, rng.int(W.home.length));

  // 装備できるものは装備する
  const wearable = W.inv.items.find(it => it.slot);
  if (wearable && rng.chance(0.5)) return { type: 'equip', item: wearable };

  // 降下ポッドへ向かい、降りる
  if (World.getTile(W.level, p.x, p.y) === World.TILE.DOWN) return { type: 'descend' };
  const s = stepPathTo(W, W.level.down.x, W.level.down.y);
  if (s) return { type: 'move', dx: s[0], dy: s[1] };
  const d = rng.pick(U.DIRS);
  return { type: 'move', dx: d.dx, dy: d.dy };
}

/**
 * 撤退すべき理由。無ければ null。
 * [[D-53]] の「撤退理由の半分以上が HP 以外」を測るために、
 * **HP 以外の理由でも実際に引き返す**自動プレイヤーにしてある。
 * ここに並ぶ理由が、そのまま各サイトの圧力の種類になる。
 */
function retreatReason(W) {
  const p = W.player;
  if (p.hp * 4 < p.hpMax) return 'HP';
  if (Env.sealDeficit(W) > 0) return '気密不足';
  if (p.food < 200) return '糧食';
  if ((p.exposure || 0) >= Env.EXPOSURE_STEP * 2) return '被曝';
  if ((p.contamination || 0) >= Env.CONTAMINATION_STEP * 2) return '汚染';
  if (W.alerted && W.alertLevel >= 3) return '監視';
  if (W.inv.items.length >= Inventory.MAX_ITEMS) return '所持品';
  if (p.cells <= 0 && Env.envOf(W).ambient <= 0) return '灯り';
  return null;
}

function adjacentFoe(W) {
  const p = W.player;
  for (const a of W.actors) {
    if (a.dead || a.kind === 'player') continue;
    if (U.distCheb(a.x, a.y, p.x, p.y) === 1) return a;
  }
  return null;
}

function visibleFoe(W) {
  const p = W.player;
  let best = null, bd = 99;
  for (const a of W.actors) {
    if (a.dead || a.kind === 'player') continue;
    if (!World.hasFlag(W.level, a.x, a.y, World.F.VISIBLE)) continue;
    const d = U.distCheb(a.x, a.y, p.x, p.y);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

function stepAwayFrom(W, tx, ty, rng) {
  const p = W.player;
  const dx = U.clamp(p.x - tx, -1, 1), dy = U.clamp(p.y - ty, -1, 1);
  for (const c of [[dx, dy], [dx, 0], [0, dy]]) {
    if (!c[0] && !c[1]) continue;
    if (World.walkable(W.level, p.x + c[0], p.y + c[1])) return c;
  }
  return null;
}

/** 状態の健全性を毎ステップ検査する。壊れたまま走り続けないため。 */
function assertSane(W, step) {
  const p = W.player;
  const lv = W.level;
  const at = w => `step=${step} seed=${W.seed} depth=${W.depth}`;

  if (!World.inBounds(lv, p.x, p.y)) throw new Error(`${at()} プレイヤーがマップ外 (${p.x},${p.y})`);
  if (!World.walkable(lv, p.x, p.y)) throw new Error(`${at()} プレイヤーが壁の中 (${p.x},${p.y})`);
  if (p.hp > p.hpMax) throw new Error(`${at()} HP が上限超過 ${p.hp}/${p.hpMax}`);
  if (!isFinite(p.hp) || isNaN(p.hp)) throw new Error(`${at()} HP が数値でない: ${p.hp}`);
  if (p.level < 1 || p.level > 50) throw new Error(`${at()} レベルが範囲外: ${p.level}`);
  if (p.cells < 0) throw new Error(`${at()} 電力が負: ${p.cells}`);
  if (W.inv.items.length > Inventory.MAX_ITEMS) {
    throw new Error(`${at()} 所持品が上限超過: ${W.inv.items.length}`);
  }

  for (const a of W.actors) {
    if (a.dead) continue;
    if (!World.inBounds(lv, a.x, a.y)) throw new Error(`${at()} ${a.name || a.kind} がマップ外`);
    if (!World.walkable(lv, a.x, a.y)) throw new Error(`${at()} ${a.name || a.kind} が壁の中 (${a.x},${a.y})`);
    if (a.energy > 1000) throw new Error(`${at()} エネルギーが発散: ${a.name} ${a.energy}`);
  }

  // 同じマスに2体以上居ない
  const seen = new Set();
  for (const a of W.actors) {
    if (a.dead) continue;
    const k = a.x + ',' + a.y;
    if (seen.has(k)) throw new Error(`${at()} アクターが重なっている (${k})`);
    seen.add(k);
  }

  // 床アイテムが壁に埋まっていない
  for (const it of W.items) {
    if (!World.walkable(lv, it.x, it.y)) throw new Error(`${at()} アイテムが壁の中: ${it.name}`);
  }

  // --- M2 の不変条件 ---
  for (const k of ['str', 'int', 'wis', 'dex', 'con', 'chr']) {
    const v = Stat.effective(p, k);
    if (!isFinite(v) || v < Stat.MIN || v > Stat.MAX) {
      throw new Error(`${at()} 能力値 ${k} が範囲外: ${v}`);
    }
  }
  if (p.sp < 0 || p.sp > p.spMax + 1) throw new Error(`${at()} SP が範囲外 ${p.sp}/${p.spMax}`);
  if (W.inv.credits < 0) throw new Error(`${at()} クレジットが負: ${W.inv.credits}`);
  if (W.home.length > Hub.HOME_MAX) throw new Error(`${at()} 格納庫が上限超過`);

  // 固有機材は同じものが2つ存在しない
  const uniqueIds = new Set();
  const all = W.inv.items.concat(W.items, W.home,
    Inventory.SLOTS.map(s => W.inv.equip[s]).filter(Boolean));
  for (const it of all) {
    if (!it.uniqueId) continue;
    if (uniqueIds.has(it.uniqueId)) throw new Error(`${at()} 固有機材が重複: ${it.uniqueId}`);
    uniqueIds.add(it.uniqueId);
  }

  // 名前が組み立てられる (鑑定状態が壊れていない)
  for (const it of all) {
    const n = Sigil.name(W.knowledge, it);
    if (!n || typeof n !== 'string') throw new Error(`${at()} アイテム名が壊れている: ${it.kindId}`);
  }
}

/** 1ラン。@returns 統計 */
function playOne(seed, comboIndex) {
  const combo = COMBOS[(comboIndex || 0) % COMBOS.length];
  const W = Cmd.newGame(seed, combo[0], combo[1]);
  const rng = RNG.create(seed + '/ai');
  let steps = 0;

  /* サイトを固定して測るとき、深く始まるサイト(尖塔・遺跡)に
     レベル1で放り込むと「一歩で死ぬ」しか測れない。
     深度に見合った強さから始めて、**そのサイトの圧力**を測れるようにする。 */
  const forced = SITE.id;
  if (forced) {
    const site = Site.byId(forced);
    Cmd.selectSite(W, forced);
    if (site && site.depthMin > 1) {
      // 本家の目安どおり キャラレベル ≒ 深度 まで育てて始める
      const target = Math.min(50, site.depthMin);
      Player.gainExp(W.player, Player.expNeeded(target - 1, W.player.expFactor));
      W.inv.credits += site.depthMin * 220;      // 相応の装備を買える所持金
      /* 店の品揃えは到達最深度で決まる。ここを上げないと
         「レベル20だが深度1の装備」という有り得ない状態で測ることになる。 */
      W.player.depthMax = site.depthMin;
      Site.noteDepth(W, site.id, site.depthMin);
      Cmd.recalc(W);
      W.player.hp = W.player.hpMax;
    }
    /* 母船で買い揃えてから降ろす。裸のまま深いサイトへ落とすと
       「装備が足りない」ことしか測れず、サイトの差が見えない。 */
    Cmd.enterLevel(W, 0, false);
    outfit(W, rng);
    Cmd.enterLevel(W, site ? site.depthMin : 1, false);
  }

  while (!W.dead && steps < MAX_STEPS) {
    const cmd = decide(W, rng);
    Cmd.step(W, cmd);
    steps++;
    assertSane(W, steps);
    if (VERBOSE && steps % 200 === 0) {
      console.log(`  step ${steps}  depth ${W.depth}  Lv${W.player.level}  HP ${W.player.hp}/${W.player.hpMax}`);
    }
  }

  return {
    seed, steps,
    combo: combo.join('/'),
    died: W.dead,
    site: W.site ? W.site.id : null,
    siteDepth: W.site ? Site.deepestIn(W, W.site.id) : W.player.depthMax,
    siteProgress: siteProgress(W),
    retreatWhy: W.retreatWhy || null,
    dmgEnv: W.tally.env,
    dmgFoe: W.tally.foe,
    depthMax: W.player.depthMax,
    level: W.player.level,
    turn: W.turn,
    cause: W.grave ? W.grave.cause : null,
    sigilsKnown: Object.keys(W.knowledge.sigils).length,
    loreKnown: Object.keys(W.lore).length
  };
}

/**
 * 母船で買えるだけ買って装備する。指標を測るための下準備。
 * 装備の良し悪しではなく**サイトの差**を測りたいので、
 * 全サイトで同じ手順・同じ所持金の使い方をする。
 */
function outfit(W, rng) {
  for (let round = 0; round < 40; round++) {
    let bought = false;
    for (const shop of Hub.SHOPS) {
      const stock = (W.shops && W.shops[shop.id]) || [];
      for (let i = 0; i < stock.length; i++) {
        if (Hub.buyPrice(W, stock[i]) > W.inv.credits) continue;
        if (Hub.buy(W, shop.id, i).ok) { bought = true; break; }
      }
    }
    if (!bought) break;
  }
  // 装備できるものは全部着る。良い方を選ぶ賢さは要らない(手順を揃えるのが目的)
  for (let round = 0; round < 3; round++) {
    for (const it of W.inv.items.slice()) {
      if (it.slot) Cmd.equip(W, it);
    }
  }
  Cmd.recalc(W);
  W.player.hp = W.player.hpMax;
}

/** そのサイトをどこまで踏破したか (0..1)。深度の絶対値はサイト間で比べられない。 */
function siteProgress(W) {
  if (!W.site) return 0;
  const span = Math.max(1, W.site.depthMax - W.site.depthMin);
  const reached = Site.deepestIn(W, W.site.id);
  return U.clamp((reached - W.site.depthMin) / span, 0, 1);
}

/* ---------- [[D-53]] の指標: 4サイトを回して差別化を判定する ---------- */

function runMetrics() {
  const sites = Site.all().filter(s => s.id !== 'origin');   // 《起源》は M4
  const rows = [];
  console.log(`[[D-53]] 差別化の指標  (${RUNS} ラン/サイト, 最大 ${MAX_STEPS} ステップ)\n`);

  for (const site of sites) {
    SITE_OVERRIDE = site.id;
    const r = { site, causes: {}, why: {}, prog: [], env: 0, foe: 0, runs: 0 };
    for (let i = 0; i < RUNS; i++) {
      let one;
      try { one = playOne('m/' + site.id + '/' + i, i); }
      catch (e) { console.log('  ! ' + site.id + '/' + i + ': ' + e.message); continue; }
      r.runs++;
      r.prog.push(one.siteProgress);
      r.env += one.dmgEnv; r.foe += one.dmgFoe;
      if (one.died) r.causes[one.cause] = (r.causes[one.cause] || 0) + 1;
      if (one.retreatWhy) r.why[one.retreatWhy] = (r.why[one.retreatWhy] || 0) + 1;
    }
    rows.push(r);
  }
  SITE_OVERRIDE = null;
  report(rows);
}

function topKey(obj) {
  const e = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  return e.length ? e[0][0] : '—';
}

function report(rows) {
  const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  console.log('サイト        踏破率  環境ダメ比  最頻死因            最頻撤退理由');
  const envRatio = {}, topCause = {}, prog = {};
  for (const r of rows) {
    const ratio = (r.env + r.foe) ? r.env / (r.env + r.foe) : 0;
    envRatio[r.site.id] = ratio;
    topCause[r.site.id] = topKey(r.causes);
    prog[r.site.id] = mean(r.prog);
    console.log('  ' + pad(r.site.name, 12) +
                pad((prog[r.site.id] * 100).toFixed(0) + '%', 8) +
                pad((ratio * 100).toFixed(0) + '%', 12) +
                pad(topCause[r.site.id], 20) + topKey(r.why));
  }

  console.log('\n撤退理由の内訳:');
  for (const r of rows) {
    const total = Object.values(r.why).reduce((s, v) => s + v, 0);
    const nonHp = total - (r.why['HP'] || 0);
    const parts = Object.entries(r.why).sort((a, b) => b[1] - a[1])
      .map(([k, v]) => k + ' ' + v).join(', ');
    console.log('  ' + pad(r.site.name, 12) +
                'HP以外 ' + (total ? (nonHp / total * 100).toFixed(0) : '0') + '%   ' +
                (parts || '—'));
  }

  console.log('\n判定:');
  const causes = Object.values(topCause).filter(c => c !== '—');
  judge('サイトごとに最頻死因が違う',
        new Set(causes).size >= Math.max(2, causes.length - 1),
        JSON.stringify(topCause));

  let envOk = true, envMsg = [];
  for (const id in envRatio) {
    const v = envRatio[id];
    envMsg.push(id + ' ' + (v * 100).toFixed(0) + '%');
    if (v < 0.15 || v > 0.35) envOk = false;
  }
  judge('環境ダメージが総被ダメの15〜35%', envOk, envMsg.join(' / '));

  let whyOk = true, whyMsg = [];
  for (const r of rows) {
    const total = Object.values(r.why).reduce((s, v) => s + v, 0);
    const nonHp = total - (r.why['HP'] || 0);
    whyMsg.push(r.site.id + ' ' + (total ? (nonHp / total * 100).toFixed(0) : 0) + '%');
    if (!total || nonHp * 2 < total) whyOk = false;
  }
  judge('撤退理由の半分以上が HP 以外', whyOk, whyMsg.join(' / '));

  const ps = Object.values(prog);
  judge('どのサイトも到達深度が極端に低くない',
        Math.min.apply(null, ps) > 0.15,
        Object.entries(prog).map(([k, v]) => k + ' ' + (v * 100).toFixed(0) + '%').join(' / '));
}

function pad(s, n) {
  let w = 0;
  for (const ch of String(s)) w += /[\u3000-\u9fff\uff00-\uffef\u300a\u300b]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - w));
}

let judged = { pass: 0, fail: 0 };
function judge(name, cond, detail) {
  console.log('  ' + (cond ? 'ok  ' : 'FAIL') + ' ' + name + '\n         ' + detail);
  cond ? judged.pass++ : judged.fail++;
}

/* ---------- 実行 ---------- */

if (METRICS) {
  runMetrics();
  process.exit(judged.fail ? 1 : 0);
}

if (FIXED_SEED) {
  const r = playOne(FIXED_SEED);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

console.log(`自動プレイ ${RUNS} ラン (最大 ${MAX_STEPS} ステップ/ラン)`);
const stats = { died: 0, survived: 0, depthMax: [], level: [], steps: [], causes: {},
                sigils: [], lore: [], byCombo: {} };
const failures = [];
const t0 = Date.now();

for (let i = 0; i < RUNS; i++) {
  const seed = 'auto-' + i;
  try {
    const r = playOne(seed, i);
    if (r.died) { stats.died++; stats.causes[r.cause] = (stats.causes[r.cause] || 0) + 1; }
    else stats.survived++;
    stats.depthMax.push(r.depthMax);
    stats.level.push(r.level);
    stats.steps.push(r.steps);
    stats.sigils.push(r.sigilsKnown);
    stats.lore.push(r.loreKnown);
    if (!stats.byCombo[r.combo]) stats.byCombo[r.combo] = [];
    stats.byCombo[r.combo].push(r.depthMax);
  } catch (e) {
    failures.push({ seed, message: e.message, stack: (e.stack || '').split('\n')[1] });
    if (failures.length >= 10) break;      // 同じ原因で埋まるのを防ぐ
  }
  if ((i + 1) % Math.max(1, Math.floor(RUNS / 10)) === 0) {
    process.stdout.write(`  ${i + 1}/${RUNS}\r`);
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
const avg = a => a.length ? (a.reduce((s, v) => s + v, 0) / a.length) : 0;
const max = a => a.length ? Math.max.apply(null, a) : 0;

console.log(`\n完了 ${secs}s`);
console.log(`  死亡 ${stats.died} / 生存 ${stats.survived}`);
console.log(`  到達深度  平均 ${avg(stats.depthMax).toFixed(1)}  最大 ${max(stats.depthMax)}`);
console.log(`  レベル    平均 ${avg(stats.level).toFixed(1)}  最大 ${max(stats.level)}`);
console.log(`  ステップ  平均 ${avg(stats.steps).toFixed(0)}`);
console.log(`  習得知識  刻印 ${avg(stats.sigils).toFixed(1)}  敵 ${avg(stats.lore).toFixed(1)} 種`);
const causes = Object.entries(stats.causes).sort((a, b) => b[1] - a[1]);
if (causes.length) {
  console.log('  死因:');
  for (const [c, n] of causes.slice(0, 10)) {
    console.log(`    ${String(n).padStart(4)}  ${c}`);
  }
}

if (argv.includes('--by-combo')) {
  /* 組み合わせは 8x8=64 通りあるので、1つあたりのラン数が少なく揺れる。
     **ロール別・系統別に畳んで**から見る。調整の根拠にするのはこちら。 */
  const fold = (index) => {
    const acc = {};
    for (const [combo, list] of Object.entries(stats.byCombo)) {
      const key = combo.split('/')[index];
      if (!acc[key]) acc[key] = [];
      acc[key].push(...list);
    }
    return Object.entries(acc)
      .map(([k, v]) => [k, avg(v), v.length])
      .sort((a, b) => a[1] - b[1]);
  };
  const report = (title, rows) => {
    console.log('\n  ' + title + ':');
    const lo = rows[0][1], hi = rows[rows.length - 1][1];
    for (const [k, v, n] of rows) {
      console.log(`    ${v.toFixed(1).padStart(4)} ${String(n).padStart(3)}ラン  ` +
                  `${k.padEnd(14)} ${'#'.repeat(Math.round(v * 3))}`);
    }
    console.log(`    最上位/最下位 = ${(hi / Math.max(0.1, lo)).toFixed(1)} 倍`);
  };
  report('ロール別の到達深度', fold(1));
  report('系統別の到達深度', fold(0));

  const rows = Object.entries(stats.byCombo)
    .map(([k, v]) => [k, avg(v)])
    .sort((a, b) => a[1] - b[1]);
  console.log('\n  組み合わせ別 (下位3 / 上位3。1件あたりのラン数が少ないので参考値):');
  for (const [k, v] of rows.slice(0, 3)) console.log(`    ${v.toFixed(1)}  ${k}`);
  console.log('    ...');
  for (const [k, v] of rows.slice(-3)) console.log(`    ${v.toFixed(1)}  ${k}`);
}

if (failures.length) {
  console.log(`\nクラッシュ ${failures.length} 件:`);
  for (const f of failures) console.log(`  [${f.seed}] ${f.message}\n      ${f.stack || ''}`);
  process.exit(1);
}
console.log('\nクラッシュ 0');
process.exit(0);
