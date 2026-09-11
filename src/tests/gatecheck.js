#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * gatecheck.js — 関門を「到達しうる強さ」で越えられるか測る ([[D-89]])。
 *
 *   node src/tests/gatecheck.js                  並の装備 (既定)
 *   node src/tests/gatecheck.js --gear rich      上限寄りの装備
 *   node src/tests/gatecheck.js --gear poor      能力値を伸ばしていない
 *   node src/tests/gatecheck.js --trials 30
 *
 * ## なぜ自動プレイと別に要るのか
 *
 * `autoplay.js` / `playthrough.js` は道中を通しで再現するが、**結果がボットの
 * 巧拙に左右される**ので「ボットが下手なのか、ゲームが理不尽なのか」が
 * 分からない (`[[Q-20]]`)。実際、店売り装備だけ・能力値は初期値のままの
 * ボットで測ったときは全関門 0% で、**通しクリアは不可能だと誤って結論した**。
 * 同じ関門を現実的な装備で測り直すと全て越えられた ―― 壊れていたのは
 * ゲームではなく測定器のほうだった。
 *
 * そこでここは**道中を測らない**。関門だけを切り出し、その深度に到達した人が
 * 現実的に用意できる強さを与えて、実ルールで戦わせる。
 * これで勝てないなら、腕前ではなく設計の問題だと言い切れる。
 *
 * ## 与える強さの3段階 (--gear)
 *
 * | 段 | 能力値 | 装備 | 想定 |
 * |---|---|---|---|
 * | `poor` | 初期値 (18) | 生成60回から最良 | 増強剤を使っていない人 |
 * | `plain`| 18/100 | 生成60回から最良 | **標準。ここが通るべき線** |
 * | `rich` | 18/100 | 生成600回から最良 | 相当に粘って揃えた人 |
 *
 * 能力値を分けているのは、**増強剤を飲むかどうかが打数を通じて支配的**だと
 * 測定で分かったため (18 で1打、18/100 で3打)。
 */
'use strict';
const { load } = require('./_setup');

const argv = process.argv.slice(2);
function arg(n, d) { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : d; }

const TRIALS = parseInt(arg('trials', '20'), 10);
const GEAR = arg('gear', 'plain');
const TIER = { poor: { stat: 18, tries: 60 }, plain: { stat: 28, tries: 60 }, rich: { stat: 28, tries: 600 } }[GEAR];
if (!TIER) { console.error('--gear は poor / plain / rich'); process.exit(2); }

const ctx = load();
const { U, World, Cmd, Data, Player, Site, Monster, Item, Inventory, Ability, Combat } = ctx;
Data.init(ctx.RAW);

/** 装備の良さ。スロットごとに比べる粗い指標。 */
function gearScore(it) {
  if (!it || !it.slot) return -1;
  let s = (it.ac || 0) * 3 + (it.seal || 0) * 6 + (it.toHit || 0) * 2 + (it.toDam || 0) * 3;
  if (it.dice) { const [n, f] = it.dice.split('d').map(Number); s += n * (f + 1) / 2 * 5; }
  if (it.mult) s += it.mult * 15;
  for (const g of (it.sigils || [])) s += g === 's-speed' ? 80 : (g.charAt(0) === 's' ? 10 : -8);
  return s;
}

/**
 * その深度に到達した人の、現実的な強さ。
 * 装備は**実際の生成器**をその深度で回して拾えた最良のものを取る ――
 * 店の品揃えだけを見ると刻印付きが一切入らず、実プレイとかけ離れる。
 */
function hero(seed, depth, role) {
  const W = Cmd.newGame(seed, 'synthetic', role);
  const p = W.player;
  Player.gainExp(p, Player.expNeeded(Math.min(Player.MAX_LEVEL, depth) - 1, p.expFactor));
  for (const k of ['str', 'dex', 'con', 'int', 'wis']) p.stats[k] = TIER.stat;
  p.depthMax = depth;
  Cmd.enterLevel(W, 0, false);

  const best = {};
  for (let i = 0; i < TIER.tries; i++) {
    const it = Item.makeForDepth(W.rng, depth, W);
    if (!it || !it.slot) continue;
    if (gearScore(it) > gearScore(best[it.slot])) best[it.slot] = it;
  }
  for (const slot of Object.keys(best)) {
    const it = best[slot];
    it.known = true; it.sigilsKnown = (it.sigils || []).slice();
    Inventory.add(W.inv, it);
    Cmd.equip(W, it);
  }
  const db = Data.get();
  for (const base of ['ammo', 'ampule']) {
    const pool = db.items.filter(e => e.base === base && e.depth <= depth)
                         .sort((a, b) => a.depth - b.depth);
    const kind = pool[pool.length - 1];
    if (!kind) continue;
    const it = Item.create(W.rng, kind, 40);
    it.known = true;
    Inventory.add(W.inv, it);
  }
  /* 逃げ道を塞ぐ道具と、足を止める道具を持たせる ([[D-93]] [[D-95]])。
     持たせないと「殴ることしかしない人」を測ることになり、
     転移で逃げる相手を「強い」と誤って報告する ―― 実際それで《管理人》を取り違えた。 */
  for (const prefix of ['bind', 'afflict:paralyzed']) {
    const kind = db.items.filter(e => (e.effect || '').indexOf(prefix) === 0 && e.depth <= depth)
                         .sort((a, b) => a.depth - b.depth).pop();
    if (!kind) continue;
    const it = Item.create(W.rng, kind, 15);
    it.known = true;
    Inventory.add(W.inv, it);
  }
  while (p.system && Ability.canLearnMore(p)) {
    const pool = Ability.learnable(p);
    if (!pool.length) break;
    Ability.learn(W, p, pool[pool.length - 1].id);
  }
  Cmd.recalc(W);
  p.hp = p.hpMax; p.sp = p.spMax; p.cog = p.cogMax;
  return W;
}

/**
 * 決着まで戦わせる。回復は6割を切ったら使う。
 *
 * 結果は3通りに分ける ―― **「倒せない」と「決着がつかない」は違う問題**。
 * 一緒にすると、転移で逃げて自己回復する相手が「強いから負けた」に見えてしまい、
 * 実際それで《管理人》を取り違えた。
 * @returns {{outcome:'won'|'died'|'stalled', turns:number}}
 */
function duel(W, raceId, depth) {
  const race = Data.get().monstersById[raceId];
  Cmd.enterLevel(W, depth, false);
  W.actors = W.actors.filter(a => a.kind === 'player');
  const p = W.player;
  p.hp = p.hpMax; p.sp = p.spMax;

  const foe = Monster.spawn(W.rng, race, p.x + 1, p.y);
  foe.unique = true; foe.asleep = 0;
  World.addActor(W, foe);
  Cmd.refreshView(W);

  let n = 0;
  while (!W.dead && !foe.dead && n < 4000) {
    n++;
    if (p.hp < p.hpMax * 0.6) {
      const h = W.inv.items.find(it => it.effect && it.effect.indexOf('heal') === 0);
      if (h && Cmd.step(W, { type: 'use', item: h })) continue;
    }
    // 逃げられる相手なら、まず逃げ道を塞ぐ
    if (foe.timers.bound <= 1 && U.distCheb(foe.x, foe.y, p.x, p.y) <= 5) {
      const anchor = W.inv.items.find(it => it.effect && it.effect.indexOf('bind') === 0);
      if (anchor && Cmd.step(W, { type: 'use', item: anchor, target: { x: foe.x, y: foe.y } })) continue;
    }
    // 動けるうちは足も止めにいく (抵抗されることが多い)
    if (foe.timers.paralyzed <= 1 && U.distCheb(foe.x, foe.y, p.x, p.y) <= 4) {
      const pin = W.inv.items.find(it => it.effect &&
                                         it.effect.indexOf('afflict:paralyzed') === 0);
      if (pin && Cmd.step(W, { type: 'use', item: pin, target: { x: foe.x, y: foe.y } })) continue;
    }
    const d = U.distCheb(foe.x, foe.y, p.x, p.y);
    if (d > 1 && W.inv.equip.launcher &&
        Cmd.step(W, { type: 'shoot', target: { x: foe.x, y: foe.y } })) continue;
    if (d <= 1 && p.system && p.abilities.length && p.sp > 5 &&
        Cmd.step(W, { type: 'ability', id: p.abilities[p.abilities.length - 1] })) continue;
    Cmd.step(W, { type: 'move', dx: Math.sign(foe.x - p.x) || 0, dy: Math.sign(foe.y - p.y) || 0 });
  }
  return {
    outcome: foe.dead && !W.dead ? 'won' : (W.dead ? 'died' : 'stalled'),
    turns: n
  };
}

const GATES = [
  { name: '《灰の巡回者》', id: 'u-ash-warden', depth: 30, site: 'ash' },
  { name: '《機関長》', id: 'u-chief-engineer', depth: 40, site: 'ark' },
  { name: '《培養者》', id: 'u-cultivator', depth: 60, site: 'ruins' },
  { name: '《管理人》', id: 'u-custodian', depth: 80, site: 'spire' },
  { name: '《門番》', id: 'u-warden', depth: 99, site: 'origin' },
  { name: '《起源》', id: 'u-origin', depth: 100, site: 'origin' }
];
const ROLES = ['marine', 'marksman', 'psion'];

console.log(`関門の検証 ―― 装備 ${GEAR} / ${TRIALS} 試行\n`);
console.log('関門           深度  Lv  HP   AC 速度 打数   撃破   死亡  決着つかず  平均手数  役');

const rows = [];
for (const g of GATES) {
  let best = null;
  for (const role of ROLES) {
    const tally = { won: 0, died: 0, stalled: 0 };
    let sum = 0, sample = null;
    for (let i = 0; i < TRIALS; i++) {
      const W = hero('gate/' + g.id + '/' + role + '/' + i, g.depth, role);
      for (const a of ['vacuum', 'radiation', 'contamination', 'watch']) Site.grantAdaptation(W, a);
      Cmd.selectSite(W, g.site);
      if (!sample) sample = W;
      const r = duel(W, g.id, g.depth);
      tally[r.outcome]++;
      if (r.outcome === 'won') sum += r.turns;
    }
    const row = {
      role, sample, tally,
      rate: tally.won / TRIALS,
      stall: tally.stalled / TRIALS,
      turns: tally.won ? sum / tally.won : 0
    };
    if (!best || row.rate > best.rate) best = row;
  }
  const p = best.sample.player;
  const pc = n => (Math.round(n / TRIALS * 100) + '%');
  console.log([
    g.name.padEnd(13), String(g.depth).padStart(4), String(p.level).padStart(4),
    String(p.hpMax).padStart(4), String(p.ac).padStart(4), String(p.speed).padStart(4),
    String(Combat.blowsFor(p, best.sample.inv.equip.weapon)).padStart(4),
    pc(best.tally.won).padStart(6), pc(best.tally.died).padStart(6),
    pc(best.tally.stalled).padStart(10),
    best.tally.won ? String(Math.round(best.turns)).padStart(9) : '        —',
    ' ' + best.role
  ].join(' '));
  rows.push({ gate: g, rate: best.rate, stall: best.stall });
}

/* 判定は「通れないもの」だけを落とす。
   勝率そのものを閾値にしない ―― この台は**立ち止まって殴り合う**ので、
   召喚や位置取りで解く相手を必ず低く見積もる(実測で召喚の有無は13〜20点)。
   ここで言えるのは「越えられるか」であって「ちょうど良い難度か」ではない。 */
const impossible = rows.filter(r => r.rate === 0);

console.log('');
if (impossible.length) {
  console.log('★越えられない関門:');
  for (const r of impossible) console.log(`  ${r.gate.name} (深度${r.gate.depth})`);
  console.log('\nこの装備で一度も越えられないなら、腕前ではなく設計の問題。');
  process.exit(1);
}
console.log('全ての関門を越えられる。通しクリアは成立する。');

/* **決着がつかない**のは「強い」のとは別の問題。
   転移で逃げて自己回復する相手は、追いかける側に手が無いと**負けない**が、
   それは難度ではなく行き止まり ([[Q-24]])。 */
const stalling = rows.filter(r => r.stall >= 0.3);
if (stalling.length) {
  console.log('\n⚠ 決着がつかない関門 ([[Q-24]]):');
  for (const r of stalling) {
    console.log(`  ${r.gate.name}(深度${r.gate.depth}) ―― ` +
                `${Math.round(r.stall * 100)}% が時間切れ。倒せないのではなく、捕まえられない`);
  }
}

/* 難度が深さの順になっていないのも報告する。 */
const inverted = [];
for (let i = 1; i < rows.length; i++) {
  if (rows[i].rate > rows[i - 1].rate + 0.3) {
    inverted.push(`${rows[i].gate.name}(深度${rows[i].gate.depth}) が ` +
                  `${rows[i - 1].gate.name}(深度${rows[i - 1].gate.depth}) より易しい`);
  }
}
if (inverted.length) {
  console.log('\n⚠ 難度が深さの順になっていない:');
  for (const s of inverted) console.log('  ' + s);
}
