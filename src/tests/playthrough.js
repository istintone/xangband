#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * playthrough.js — 通しクリアが成立するかを実ルールで確かめる。
 *
 *   node src/tests/playthrough.js
 *   node src/tests/playthrough.js --runs 5 --verbose
 *
 * M4 の受け入れ基準は「通しクリアが可能」。
 * `[[D-66]]` では開発用起動で**機構**が繋がっていることだけを確かめ、
 * 「実際に育って勝てるか」は M5 に回した。ここがその M5 ぶん。
 *
 * **開発用の下駄は一切使わない。** 深度1から始め、店で買い、潜り、
 * 《適合》を4つ集め、《起源》へ降りて倒し、母船へ帰るまでを実ルールで通す。
 *
 * ★測定器としての限界 (`[[Q-20]]`):
 *   経路探索は**未知のマスも通る**。人間の情報状態は再現しない。
 *   確かめたいのは「コンテンツと成長曲線が最後まで繋がっているか」であって、
 *   探索の巧拙ではない。戦闘・資源・成長・買い物は全て実ルール。
 */
'use strict';
const { load } = require('./_setup');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i !== -1 ? argv[i + 1] : d; };
const RUNS = parseInt(arg('runs', '1'), 10);
const VERBOSE = argv.includes('--verbose');
const MAX_TURNS = parseInt(arg('turns', '400000'), 10);

const ctx = load();
const { RNG, U, World, Cmd, Data, Item, Inventory, Player, Ability, Sigil,
        Hub, Site, Monster, Env, Craft, Combat } = ctx;
Data.init(ctx.RAW);

/* ---------- 経路 (測定器の特権: 未知のマスも通る) ---------- */

function stepToward(W, tx, ty) {
  const lv = W.level, p = W.player;
  if (p.x === tx && p.y === ty) return null;
  const prev = new Int32Array(lv.w * lv.h).fill(-1);
  const start = p.y * lv.w + p.x, goal = ty * lv.w + tx;
  prev[start] = start;
  let queue = [start], found = false;
  while (queue.length && !found) {
    const next = [];
    for (const cur of queue) {
      const cx = cur % lv.w, cy = (cur - cx) / lv.w;
      for (const d of U.DIRS) {
        const nx = cx + d.dx, ny = cy + d.dy;
        if (!World.inBounds(lv, nx, ny)) continue;
        const n = ny * lv.w + nx;
        if (prev[n] !== -1 || !World.walkable(lv, nx, ny)) continue;
        prev[n] = cur;
        if (n === goal) { found = true; break; }
        next.push(n);
      }
      if (found) break;
    }
    queue = next;
  }
  if (prev[goal] === -1) return null;
  let node = goal;
  while (prev[node] !== start) { node = prev[node]; if (node === start) return null; }
  const nx = node % lv.w, ny = (node - nx) / lv.w;
  return [nx - p.x, ny - p.y];
}

/* ---------- 買い物 ---------- */

/** 装備の良さ。スロットごとに比べる用の粗い指標。 */
function gearScore(W, it) {
  if (!it || !it.slot) return -1;
  let s = (it.ac || 0) * 3 + (it.seal || 0) * 6 + (it.toHit || 0) + (it.toDam || 0) * 2;
  if (it.dice) { const [n, f] = it.dice.split('d').map(Number); s += n * (f + 1) / 2 * 4; }
  if (it.mult) s += it.mult * 12;
  if (it.radius) s += it.radius * 4;
  const b = Inventory.equipBonus ? null : null;
  for (const sig of (it.sigils || [])) {
    if (sig === 's-speed') s += 60;
    else if (sig.charAt(0) === 's') s += 8;
    else s -= 6;                       // 汚染ファーム
  }
  return s;
}

function shop(W, log) {
  Cmd.enterLevel(W, 0, false);
  W.player.hp = W.player.hpMax;

  /* ★順序が大事。**修理が先**。
     消耗品で使い切ってから修理しようとして失敗し、
     装甲が壊れたまま深部へ行って AC2 で死んでいた。 */
  Hub.repairService(W);
  Hub.cureService(W);

  /* 買い物は2周する。
     1周目: 装備の更新(高いので先に確保する)
     2周目: 消耗品(残りで買えるだけ) */
  for (const phase of ['gear', 'supply']) {
    for (let round = 0; round < 20; round++) {
      let bought = false;
      for (const s of Hub.SHOPS) {
        const stock = (W.shops && W.shops[s.id]) || [];
        for (let i = 0; i < stock.length; i++) {
          const it = stock[i];
          if (Hub.buyPrice(W, it) > W.inv.credits) continue;
          if (W.inv.items.length >= Inventory.MAX_ITEMS - 2) continue;

          let want = false;
          if (phase === 'gear') {
            want = !!it.slot && gearScore(W, it) > gearScore(W, W.inv.equip[it.slot]);
          } else if (!it.slot) {
            if (it.base === 'ampule' || it.base === 'protocol') {
              want = W.inv.items.filter(x => x.base === it.base).length < 6;
            } else if (it.base === 'ration' || it.base === 'cell' || it.base === 'ammo') {
              want = W.inv.items.filter(x => x.base === it.base).length < 4;
            }
          }
          if (!want) continue;
          if (Hub.buy(W, s.id, i).ok) { bought = true; equipBest(W); break; }
        }
      }
      if (!bought) break;
    }
  }

  equipBest(W);
  Cmd.recalc(W);
  W.player.hp = W.player.hpMax;

  // 能力を覚えられるだけ覚える
  learnAll(W);
  log(`  母船: Lv${W.player.level} HP${W.player.hpMax} AC${W.player.ac} 気密${W.player.seal} $${W.inv.credits}`);
}

/** 持っているもので一番良い装備に着替える。 */
function equipBest(W) {
  for (let r = 0; r < 3; r++) {
    for (const it of W.inv.items.slice()) {
      if (!it.slot) continue;
      if (gearScore(W, it) > gearScore(W, W.inv.equip[it.slot])) Cmd.equip(W, it);
    }
  }
}

function learnAll(W) {
  const p = W.player;
  while (p.system && Ability.canLearnMore(p)) {
    const pool = Ability.learnable(p);
    if (!pool.length) break;
    Ability.learn(W, p, pool[pool.length - 1].id);
  }
}

/* ---------- 1階の攻略 ---------- */

function healItem(W) {
  return W.inv.items.find(it => it.effect && it.effect.indexOf('heal') === 0);
}
function foodItem(W) {
  return W.inv.items.find(it => it.effect && it.effect.indexOf('feed') === 0);
}

/**
 * 1階ぶん進む。
 * @returns {'down'|'dead'|'stuck'|'guardian'} 何で終わったか
 */
function nearest(W, list) {
  const p = W.player;
  let best = null, bd = 1e9;
  for (const a of list) {
    const d = U.distCheb(a.x, a.y, p.x, p.y);
    if (d < bd) { bd = d; best = a; }
  }
  return best;
}

function playFloor(W, opts) {
  const p = W.player;
  let steps = 0;
  const limit = opts.limit || 4000;
  let idle = 0, lastKey = '';

  while (steps++ < limit) {
    // 進んでいないことを検知する。同じ状態が続いたら諦める
    const key = p.x + ',' + p.y + ',' + W.turn;
    if (key === lastKey) { if (++idle > 30) { stuckWhy = '同じ状態から動けない'; return 'stuck'; } }
    else { idle = 0; lastKey = key; }
    if (W.dead) return 'dead';
    if (W.turn > MAX_TURNS) return 'stuck';

    // --- 立て直し ---
    if (p.hp * 2 < p.hpMax) {
      const h = healItem(W);
      if (h && Cmd.step(W, { type: 'use', item: h })) continue;
    }
    if (p.food < 400) {
      const f = foodItem(W);
      if (f && Cmd.step(W, { type: 'use', item: f })) continue;
    }
    if (p.cells < 30) {
      const cell = W.inv.items.find(it => it.effect && it.effect.indexOf('cell') === 0);
      if (cell && Cmd.step(W, { type: 'use', item: cell })) continue;
    }

    const foe = Cmd.visibleFoe(W);

    // --- 目標: 守護がいるならそれを倒す ---
    const guard = opts.hunt ? W.actors.find(a => a.guardian && !a.dead) : null;
    const boss = opts.boss ? W.actors.find(a => a.raceId === opts.boss && !a.dead) : null;

    /* 狙っていないユニークには挑まない。
       実プレイでも Lv9 で《一等航海士》に挑む人はいない ――
       この判断を入れないと、毎回そこで終わる。 */
    const wanted = boss || guard;
    const avoid = !wanted && foe && foe.unique;
    const target = wanted || (avoid ? null : foe);

    if (avoid && W.level.down) {
      // 見なかったことにして先へ進む
      const away = stepToward(W, W.level.down.x, W.level.down.y);
      if (away && Cmd.step(W, { type: 'move', dx: away[0], dy: away[1] })) continue;
    }

    // --- 敵が見えず HP が減っていれば休む ---
    if (!foe && p.hp < p.hpMax) {
      const before = p.hp;
      Cmd.rest(W, 200);
      if (p.hp > before) continue;
    }

    /* --- 退く。**勝てない戦いを続けない** ---
       人間なら当然やることだが、入れないと深度3 で死ぬ。
       回復薬があっても、半分を切ったら一度引く ――
       飲みながら殴り合って負けるのが一番多い負け方だった。 */
    const losing = p.hp * 2 < p.hpMax && !wanted;
    if ((losing || (p.hp * 3 < p.hpMax && !healItem(W))) && W.level.up) {
      const away = stepToward(W, W.level.up.x, W.level.up.y);
      if (away) {
        Cmd.step(W, { type: 'move', dx: away[0], dy: away[1] });
        if (p.x === W.level.up.x && p.y === W.level.up.y) {
          Cmd.step(W, { type: 'ascend' });
          return 'retreat';
        }
        continue;
      }
    }

    if (target) {
      const d = U.distCheb(target.x, target.y, p.x, p.y);
      if (d === 1) {
        Cmd.step(W, { type: 'move',
                      dx: Math.sign(target.x - p.x), dy: Math.sign(target.y - p.y) });
        if (target.dead && (target === boss || target === guard)) return 'guardian';
        continue;
      }
      /* 遠隔と能力は**失敗しうる**(弾切れ・SP不足・射線が無い)。
         ターンを消費しなかったら次の手に回す ―― でないと空回りする。 */
      const seen = World.hasFlag(W.level, target.x, target.y, World.F.VISIBLE);
      if (seen && W.inv.equip.launcher &&
          Cmd.step(W, { type: 'shoot', target: { x: target.x, y: target.y } })) {
        if (target.dead) return 'guardian';
        continue;
      }
      if (seen && p.system && p.abilities.length && p.sp > 2 &&
          Cmd.step(W, { type: 'ability', id: p.abilities[p.abilities.length - 1] })) {
        continue;
      }
      const s = stepToward(W, target.x, target.y);
      if (s && Cmd.step(W, { type: 'move', dx: s[0], dy: s[1] })) continue;
    }

    // --- 拾う ---
    if (Item.itemsAt(W, p.x, p.y).length && W.inv.items.length < Inventory.MAX_ITEMS - 1 &&
        Cmd.step(W, { type: 'pickup' })) {
      equipBest(W);          // 拾ったものが良ければその場で着る
      continue;
    }
    const loot = nearest(W, W.items.filter(it => U.distCheb(it.x, it.y, p.x, p.y) < 25));
    if (loot && W.inv.items.length < Inventory.MAX_ITEMS - 3) {
      const s = stepToward(W, loot.x, loot.y);
      if (s && Cmd.step(W, { type: 'move', dx: s[0], dy: s[1] })) continue;
    }

    // --- 目標が居るのに倒せていないなら、この階はここまで ---
    if (opts.hunt && !W.actors.some(a => a.guardian && !a.dead)) return 'guardian';

    /* --- 潜る速さを抑える ([[Q-20]]) ---
       本家の目安どおり **キャラレベル ≒ 深度** まで育ててから降りる。
       これを入れないと、育つ前に深部へ入って必ず死ぬ。
       階に敵が残っているなら狩り、居なければ降りる。 */
    if (!opts.hunt && !opts.boss && p.level < W.depth + 2) {
      const prey = nearest(W, W.actors.filter(a => a.kind === 'monster' && !a.dead));
      if (prey) {
        const s2 = stepToward(W, prey.x, prey.y);
        if (s2 && Cmd.step(W, { type: 'move', dx: s2[0], dy: s2[1] })) continue;
      }
    }

    // --- 階段へ ---
    if (!W.level.down) return 'stuck';
    if (p.x === W.level.down.x && p.y === W.level.down.y) return 'down';
    const s = stepToward(W, W.level.down.x, W.level.down.y);
    if (!s) { stuckWhy = '降下シャフトへの道が無い'; return 'stuck'; }
    if (!Cmd.step(W, { type: 'move', dx: s[0], dy: s[1] })) {
      stuckWhy = '階段へ進めない (' + p.x + ',' + p.y + ')';
      return 'stuck';
    }
  }
  stuckWhy = steps >= limit ? ('手数上限 ' + limit) : '不明';
  return 'stuck';
}

var stuckWhy = '';

/* ---------- サイトを潜り切る ---------- */

function diveSite(W, siteId, log) {
  const site = Data.get().sitesById[siteId];
  const r = Cmd.selectSite(W, siteId);
  if (!r.ok) return { ok: false, why: r.reason };

  shop(W, log);
  Cmd.step(W, { type: 'descend' });
  if (W.depth === 0) {                       // 降下ポッドへ移動してから
    const d = W.level.down;
    W.player.x = d.x; W.player.y = d.y;
    Cmd.step(W, { type: 'descend' });
  }

  let deepest = W.depth;
  let lastResupply = -1;
  while (!W.dead && W.depth > 0) {
    const atBottom = W.depth >= site.depthMax;
    const res = playFloor(W, { hunt: atBottom });
    deepest = Math.max(deepest, W.depth);

    if (W.dead) return { ok: false, why: `深度${W.depth} で死亡 (${W.grave && W.grave.cause})`, deepest };
    if (res === 'stuck') return { ok: false, why: `深度${W.depth} で進めなくなった (${stuckWhy})`, deepest };
    if (res === 'retreat') {
      // 上へ逃げた。休んで態勢を立て直す
      Cmd.rest(W, 2000);
      continue;
    }

    if (atBottom) {
      if (Site.hasAdaptation(W, site.adaptation)) {
        log(`  ${site.name}: 深度${W.depth} で《適合:${Site.ADAPTATION_NAME[site.adaptation]}》`);
        // 母船へ戻る
        Cmd.enterLevel(W, 0, false);
        return { ok: true, deepest };
      }
      // 守護を倒せていない
      return { ok: false, why: `${site.name} 最深部で守護を倒せない`, deepest };
    }
    /* 補給に戻る。実際のプレイでは帰投ビーコンで何度も往復する ――
       一度潜ったら戻らない前提で測ると、装備が壊れたまま深部へ行くことになる。
       ゲーム側の再降下(到達最深度から)を使うので、深度は失わない。 */
    const lowSupply = !healItem(W) || W.player.food < 1200;
    if ((W.depth % 5 === 0 || lowSupply) && lastResupply !== W.depth) {
      lastResupply = W.depth;          // 同じ深度で何度も往復しない
      const back = W.depth;
      Cmd.enterLevel(W, 0, false);
      shop(W, () => {});
      W.player.x = W.level.down.x; W.player.y = W.level.down.y;
      Cmd.step(W, { type: 'descend' });
      if (W.depth < back) Cmd.enterLevel(W, back, false);
      continue;
    }

    Cmd.step(W, { type: 'descend' });
    if (VERBOSE && W.depth % 10 === 0) {
      log(`    深度${W.depth} Lv${W.player.level} HP${W.player.hp}/${W.player.hpMax} AC${W.player.ac}`);
    }
  }
  return { ok: false, why: '母船に戻された', deepest };
}

/* ---------- 1ラン ---------- */

function playOne(seed, log) {
  const W = Cmd.newGame(seed, 'synthetic', 'marksman');
  const reached = {};

  // 浅い順に潜る。灰(30) → 方舟(40) → 遺跡(60) → 尖塔(80)
  for (const id of ['ash', 'ark', 'ruins', 'spire']) {
    const r = diveSite(W, id, log);
    reached[id] = r.deepest || 0;
    if (!r.ok) return { won: false, why: r.why, reached, W };
  }

  // 《起源》へ
  log(`  《適合》 ${Site.adaptationCount(W)}/4`);
  const sel = Cmd.selectSite(W, 'origin');
  if (!sel.ok) return { won: false, why: '《起源》に入れない: ' + sel.reason, reached, W };

  shop(W, log);
  W.player.x = W.level.down.x; W.player.y = W.level.down.y;
  Cmd.step(W, { type: 'descend' });

  while (!W.dead && W.depth > 0 && W.depth < 100) {
    const res = playFloor(W, {
      boss: W.depth === 99 ? 'u-warden' : null
    });
    if (W.dead) return { won: false, why: `深度${W.depth} で死亡 (${W.grave && W.grave.cause})`, reached, W };
    if (res === 'stuck') return { won: false, why: `深度${W.depth} で進めなくなった (${stuckWhy})`, reached, W };
    Cmd.step(W, { type: 'descend' });
    if (VERBOSE) log(`    深度${W.depth} Lv${W.player.level} HP${W.player.hp}/${W.player.hpMax}`);
  }

  if (W.depth === 100) {
    playFloor(W, { boss: 'u-origin', limit: 8000 });
    if (W.dead) return { won: false, why: '《起源》に敗北', reached, W };
    if (!Cmd.isReturning(W)) return { won: false, why: '《起源》を倒しきれない', reached, W };

    // 帰還
    let hops = 0;
    while (W.depth > 0 && hops++ < 30 && !W.dead) {
      const up = W.level.up;
      const s = stepToward(W, up.x, up.y);
      if (s) { Cmd.step(W, { type: 'move', dx: s[0], dy: s[1] }); continue; }
      Cmd.step(W, { type: 'ascend' });
    }
    if (W.won) return { won: true, reached, W };
    return { won: false, why: '帰還できなかった', reached, W };
  }
  return { won: false, why: `深度${W.depth} で止まった`, reached, W };
}

/* ---------- 実行 ---------- */

console.log(`通しプレイ ${RUNS} ラン (開発用の下駄なし)\n`);
let won = 0;
for (let i = 0; i < RUNS; i++) {
  const seed = 'run-' + i;
  console.log(`[${seed}]`);
  const log = (s) => console.log(s);
  let r;
  try {
    r = playOne(seed, log);
  } catch (e) {
    console.log(`  例外: ${e.message}`);
    console.log(`    ${(e.stack || '').split('\n')[1] || ''}`);
    continue;
  }
  const p = r.W.player;
  const gear = Object.entries(r.W.inv.equip).filter(([, v]) => v)
    .map(([k, v]) => k + ':' + v.name + (v.ac ? '(AC' + v.ac + ')' : '')).join(' ');
  console.log(`  到達: ${Object.entries(r.reached).map(([k, v]) => k + v).join(' ')}` +
              `  Lv${p.level} HP${p.hpMax} AC${p.ac} 気密${p.seal} T${r.W.turn}`);
  console.log(`  装備: ${gear || '(なし)'}`);
  if (r.won) { won++; console.log('  ★クリア'); }
  else console.log(`  未達: ${r.why}`);
}
console.log(`\n${won}/${RUNS} クリア`);
process.exit(won ? 0 : 1);
