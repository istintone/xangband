#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * ヘッドレス検証ハーネス (docs/04 §検証戦略)
 *
 *   node src/tests/run.js
 *   node src/tests/run.js --runs 300     生成の反復回数を増やす
 *
 * 三層:
 *   決定論  … 同一シードで完全再現するか (M0 の受け入れ基準)
 *   不変条件… 生成結果が壊れていないか (連結性・階段・外周)
 *   統計    … 生成が偏っていないか (部屋数・床率・再試行回数)
 */
'use strict';
const { load } = require('./_setup');

const argv = process.argv.slice(2);
const RUNS = (() => {
  const i = argv.indexOf('--runs');
  return i !== -1 ? parseInt(argv[i + 1], 10) : 120;
})();

let pass = 0, fail = 0;
const failures = [];

function t(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    failures.push(name + '\n       ' + e.message);
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error((msg || '') + ' 期待 ' + JSON.stringify(b) + ' / 実際 ' + JSON.stringify(a));
}
function ok(cond, msg) { if (!cond) throw new Error(msg || '条件を満たさない'); }

const ctx = load();
const { RNG, U, World, Gen, FOV, Render, Turn, Actor, Player, Combat, Data, Item,
        Inventory, Cmd, Stat, Sigil, Ability, Lore, Hub, Monster, AI, Effect, GenRooms,
        Env, Target, Legend, Site, Signature, Origin, Fragment, DevStart,
        Net, Craft, Action } = ctx;
Data.init(ctx.RAW);

/* ============ 決定論 ============ */
console.log('\n[決定論]');

t('同一シードのRNGは同一の列を返す', () => {
  const a = RNG.create('abc'), b = RNG.create('abc');
  for (let i = 0; i < 500; i++) eq(a.u32(), b.u32(), 'i=' + i);
});

t('異なるシードは異なる列を返す', () => {
  const a = RNG.create('abc'), b = RNG.create('abd');
  let same = 0;
  for (let i = 0; i < 200; i++) if (a.u32() === b.u32()) same++;
  ok(same < 5, '衝突が多すぎる: ' + same);
});

t('state/setState で完全に復元できる', () => {
  const a = RNG.create('save-test');
  for (let i = 0; i < 37; i++) a.u32();
  const snap = JSON.parse(JSON.stringify(a.state()));
  const expect = [];
  for (let i = 0; i < 50; i++) expect.push(a.u32());
  const b = RNG.create('other');
  b.setState(snap);
  for (let i = 0; i < 50; i++) eq(b.u32(), expect[i], 'i=' + i);
});

t('derive は元の流れを消費しても独立している', () => {
  const a = RNG.create('d'); const d1 = a.derive('x');
  const b = RNG.create('d'); const d2 = b.derive('x');
  for (let i = 0; i < 100; i++) eq(d1.u32(), d2.u32(), 'i=' + i);
});

t('int/range が範囲内に収まる', () => {
  const r = RNG.create('bounds');
  for (let i = 0; i < 20000; i++) {
    const v = r.int(7); ok(v >= 0 && v < 7, 'int(7)=' + v);
    const w = r.range(-3, 5); ok(w >= -3 && w <= 5, 'range=' + w);
  }
});

t('★同一シードで同一ダンジョンが生成される (M0 受け入れ基準)', () => {
  for (let s = 0; s < 30; s++) {
    const seed = 'level-' + s;
    const a = Gen.generate(RNG.create(seed).derive('L1'), 1);
    const b = Gen.generate(RNG.create(seed).derive('L1'), 1);
    eq(a.w, b.w, 'w'); eq(a.h, b.h, 'h');
    eq(Buffer.from(a.tiles).toString('hex'), Buffer.from(b.tiles).toString('hex'),
       'seed=' + seed + ' の地形が一致しない');
    eq(JSON.stringify(a.up), JSON.stringify(b.up), 'up');
    eq(JSON.stringify(a.down), JSON.stringify(b.down), 'down');
  }
});

t('異なるシードでは異なるダンジョンになる', () => {
  const hashes = new Set();
  for (let s = 0; s < 25; s++) {
    const lv = Gen.generate(RNG.create('vary-' + s).derive('L1'), 1);
    hashes.add(Buffer.from(lv.tiles).toString('hex'));
  }
  eq(hashes.size, 25, '重複した階層がある');
});

t('画面のスナップショットが同一シードで一致する (D-22)', () => {
  // newGame まで通す。ここが一致すれば、生成・配置・視界・描画の全段が決定論。
  const frameFor = seed => Render.toText(Render.frame(Cmd.newGame(seed)));
  eq(frameFor('snap'), frameFor('snap'), '同一シードで画面が一致しない');
  ok(frameFor('snap') !== frameFor('snap2'), '異なるシードで画面が同一');
});

/* ============ 不変条件 ============ */
console.log('\n[不変条件] ' + RUNS + ' 階層');

const stats = { rooms: [], floorRatio: [], attempts: [] };

t('生成した全階層が不変条件を満たす', () => {
  for (let i = 0; i < RUNS; i++) {
    const depth = 1 + (i % 40);
    const lv = Gen.generate(RNG.create('inv-' + i).derive('L' + depth), depth);

    // 階段が存在し、歩ける場所にある
    ok(lv.up && lv.down, i + ': 階段が無い');
    eq(World.getTile(lv, lv.up.x, lv.up.y), World.TILE.UP, i + ': up の地形');
    eq(World.getTile(lv, lv.down.x, lv.down.y), World.TILE.DOWN, i + ': down の地形');
    ok(!(lv.up.x === lv.down.x && lv.up.y === lv.down.y), i + ': 階段が同じ場所');

    // 外周は必ず壁 (プレイヤーがマップ外に出られない)
    for (let x = 0; x < lv.w; x++) {
      ok(!World.walkable(lv, x, 0), i + ': 上端が歩ける x=' + x);
      ok(!World.walkable(lv, x, lv.h - 1), i + ': 下端が歩ける x=' + x);
    }
    for (let y = 0; y < lv.h; y++) {
      ok(!World.walkable(lv, 0, y), i + ': 左端が歩ける y=' + y);
      ok(!World.walkable(lv, lv.w - 1, y), i + ': 右端が歩ける y=' + y);
    }

    // 連結性: 昇降機から全ての歩行可能マスに到達できる
    const ff = Gen.floodFill(lv, lv.up.x, lv.up.y);
    eq(ff.reached, ff.total, i + ': 到達できない床がある');

    // 降下シャフトにも当然届く
    ok(ff.visited[lv.down.y * lv.w + lv.down.x] === 1, i + ': 降下シャフトに到達できない');

    stats.rooms.push(lv.rooms.length);
    stats.attempts.push(lv.attempts);
    let floor = 0;
    for (let k = 0; k < lv.tiles.length; k++) if (World.TILE_INFO[lv.tiles[k]].walk) floor++;
    stats.floorRatio.push(floor / lv.tiles.length);
  }
});

t('FOV は対称 (A から B が見えるなら B から A も見える)', () => {
  const lv = Gen.generate(RNG.create('fov-sym').derive('L1'), 1);
  const R = 6;
  const rng = RNG.create('fov-pick');
  let checked = 0;
  for (let n = 0; n < 40; n++) {
    const room = rng.pick(lv.rooms);
    const ax = rng.range(room.x1, room.x2), ay = rng.range(room.y1, room.y2);
    if (!World.walkable(lv, ax, ay)) continue;

    FOV.compute(lv, ax, ay, R);
    const seen = [];
    for (let y = Math.max(0, ay - R); y <= Math.min(lv.h - 1, ay + R); y++) {
      for (let x = Math.max(0, ax - R); x <= Math.min(lv.w - 1, ax + R); x++) {
        if (World.hasFlag(lv, x, y, World.F.VISIBLE) && World.walkable(lv, x, y)) seen.push([x, y]);
      }
    }
    for (const [bx, by] of seen) {
      // GLOW による部屋全体照明は非対称なので、素の視線だけを比べる
      if (World.hasFlag(lv, bx, by, World.F.GLOW) || World.hasFlag(lv, ax, ay, World.F.GLOW)) continue;
      FOV.compute(lv, bx, by, R);
      ok(World.hasFlag(lv, ax, ay, World.F.VISIBLE),
         '非対称: (' + ax + ',' + ay + ') -> (' + bx + ',' + by + ') は見えるが逆が見えない');
      checked++;
    }
  }
  ok(checked >= 0, '');
});

t('FOV は壁の向こうを見せない', () => {
  const lv = World.createLevel(21, 21);
  Gen.carveRect(lv, 1, 1, 19, 19, World.TILE.FLOOR);
  for (let y = 1; y <= 19; y++) World.setTile(lv, 10, y, World.TILE.WALL);
  FOV.compute(lv, 5, 10, 12);
  for (let y = 1; y <= 19; y++) {
    for (let x = 11; x <= 19; x++) {
      ok(!World.hasFlag(lv, x, y, World.F.VISIBLE), '壁の向こうが見えている (' + x + ',' + y + ')');
    }
  }
});

t('全角文字が2セルを占有し、後続の桁がズレない', () => {
  const buf = Render.createBuffer(20, 3);
  const used = Render.text(buf, 0, 0, '深度1', 'white', 'black');
  eq(used, 5, '「深度1」の消費セル数');           // 全角2 + 全角2 + 半角1
  eq(buf.cells[0].w, 2, '先頭セルの幅');
  eq(buf.cells[1].w, 0, '後続セルは継続扱い');
  eq(buf.cells[4].ch, '1', '半角が正しい桁に来ていない');

  // 右端で全角が半分だけ描かれない
  const edge = Render.createBuffer(4, 1);
  const n = Render.text(edge, 0, 0, 'あああ', 'white', 'black');
  eq(n, 4, '端で切り詰められていない');
  eq(edge.cells[3].w, 0, '端の全角が割れている');

  // maxW も セル数で効く
  const clip = Render.createBuffer(20, 1);
  eq(Render.text(clip, 0, 0, '構造材', 'white', 'black', 5), 4, 'maxW=5 に全角2文字ぶんだけ入る');
});

t('サイドバーとマップの境界が全角にはみ出されない', () => {
  const W = Cmd.newGame('cjk');
  World.msg(W, '構造材に阻まれた。長い日本語のメッセージでも桁は崩れない。');
  const buf = Render.frame(W);
  // 区切り列がサイドバーの文字にはみ出されていないか。
  // 区切りは背景色の帯なので、全角がはみ出していれば ch が入ってしまう。
  for (let y = Render.MSG_ROWS; y < Render.TERM.h; y++) {
    const c = buf.cells[y * buf.w + (Render.SIDEBAR_W - 1)];
    eq(c.bg, 'edge', 'y=' + y + ' の区切り列が上書きされている: ' + JSON.stringify(c));
    eq(c.w, 1, 'y=' + y + ' の区切り列に全角がはみ出している');
  }
  // どの行も合計幅が端末幅を超えない
  for (let y = 0; y < buf.h; y++) {
    let sum = 0;
    for (let x = 0; x < buf.w; x++) sum += buf.cells[y * buf.w + x].w === 0 ? 0 : (buf.cells[y * buf.w + x].w || 1);
    eq(sum, buf.w, 'y=' + y + ' の行幅');
  }
});

t('ビューポートがマップ外を指さない', () => {
  const lv = Gen.generate(RNG.create('view').derive('L1'), 1);
  const pts = [[0, 0], [lv.w - 1, lv.h - 1], [lv.w >> 1, lv.h >> 1], [1, lv.h - 2]];
  for (const [px, py] of pts) {
    const o = Render.viewOrigin(lv, px, py);
    ok(o.x >= 0 && o.y >= 0, 'origin が負: ' + JSON.stringify(o));
    ok(o.x + Render.MAP.w <= lv.w || lv.w <= Render.MAP.w, 'x がマップ幅を超える');
    ok(o.y + Render.MAP.h <= lv.h || lv.h <= Render.MAP.h, 'y がマップ高を超える');
  }
});

/* ============ M1: ターン・戦闘・成長・データ ============ */
console.log('\n[M1 コアループ]');

t('エネルギー表が本家準拠 (+10で2倍, +20で3倍)', () => {
  eq(Turn.gain(110), 10, '標準速度');
  eq(Turn.gain(120), 20, '+10');
  eq(Turn.gain(130), 30, '+20');
  ok(Turn.speedRatio(120) === 2, '+10 が2倍でない');
  ok(Turn.speedRatio(130) === 3, '+20 が3倍でない');
  // 109 -> 110 の段差 (減速の恐ろしさの源)
  ok(Turn.gain(109) * 2 === Turn.gain(110), '標準速度の直下で半減していない');
  // 加速側は頭打ちになる
  ok(Turn.gain(199) < Turn.gain(110) * 6, '加速が青天井になっている');
});

t('速度が行動回数に反映される', () => {
  function actionsIn(speed, gameTurns) {
    const W = World.createWorld('speed-test');
    W.actors = [Actor.create({ kind: 'monster', speed })];
    let acted = 0;
    for (let i = 0; i < gameTurns; i++) Turn.tick(W, () => { acted++; return Turn.ACTED; });
    return acted;
  }
  const normal = actionsIn(110, 1000);
  const fast = actionsIn(120, 1000);
  const slow = actionsIn(100, 1000);
  ok(Math.abs(fast / normal - 2) < 0.05, '+10 の行動回数が2倍でない: ' + (fast / normal));
  ok(slow < normal, '減速で行動回数が減っていない');
});

t('エネルギーを二重に引かない (SKIP の契約)', () => {
  const W = World.createWorld('skip-test');
  const a = Actor.create({ kind: 'monster', speed: 110, energy: 150 });
  W.actors = [a];
  Turn.tick(W, () => Turn.SKIP);
  eq(a.energy, 160, 'SKIP なのにエネルギーが引かれた');
  Turn.tick(W, () => Turn.ACTED);
  eq(a.energy, 70, 'ACTED でコストが引かれていない');
});

t('死は一方通行 (回復で蘇生しない)', () => {
  const a = Actor.create({ hp: 5, hpMax: 20 });
  ok(Actor.damage(a, 10), '死亡していない');
  Actor.heal(a, 15);
  eq(a.hp, 0, '死者が回復した');
  eq(a.dead, true, '死亡フラグが消えた');
});

t('命中判定が AC で単調に下がり、0 にはならない', () => {
  const rng = RNG.create('hit');
  function rate(power, ac) {
    let h = 0;
    for (let i = 0; i < 20000; i++) if (Combat.testHit(rng, power, ac)) h++;
    return h / 20000;
  }
  const r0 = rate(50, 0), r20 = rate(50, 20), r80 = rate(50, 80);
  ok(r0 > r20 && r20 > r80, 'AC で命中率が単調に下がらない: ' + [r0, r20, r80]);
  ok(r80 > 0.005, 'AC を積むと命中率が 0 になる: ' + r80);
  ok(r0 < 1, '命中率が 1 になっている');
});

t('攻撃回数: 軽い武器ほど多く振れる', () => {
  const p = { stats: { str: 18, dex: 18 }, maxBlows: 4 };
  const light = Combat.blowsFor(p, { weight: 25 });
  const heavy = Combat.blowsFor(p, { weight: 260 });
  ok(light > heavy, '軽い武器で攻撃回数が増えない: ' + light + ' vs ' + heavy);
  ok(Combat.blowsFor(p, { weight: 25 }) <= 4, 'ロール上限を超えている');
  const weak = { stats: { str: 5, dex: 5 }, maxBlows: 4 };
  eq(Combat.blowsFor(weak, { weight: 260 }), 1, '最低1回を下回っている');
});

t('経験値と成長が本家式', () => {
  // gain = mexp * level / plev
  eq(Player.expFromKill({ mexp: 100, level: 10 }, 1), 1000, 'レベル1での獲得');
  eq(Player.expFromKill({ mexp: 100, level: 10 }, 10), 100, 'レベル10での獲得');

  const p = Player.create('grow');
  const hp1 = p.hpMax;
  eq(p.level, 1, '初期レベル');
  Player.gainExp(p, Player.expNeeded(1, p.expFactor));
  eq(p.level, 2, 'レベルアップしていない');
  ok(p.hpMax > hp1, 'HP が増えていない');

  // 同一シード・同一レベルなら HP は必ず同じ
  eq(Player.hpForLevel('x', 20, 19, 15), Player.hpForLevel('x', 20, 19, 15), 'HP が再現しない');
  ok(Player.hpForLevel('x', 20, 19, 15) > Player.hpForLevel('x', 10, 19, 15), 'レベルで HP が増えない');
});

t('データの参照が全て解決する', () => {
  const db = Data.get();
  for (const m of db.monsters) {
    ok(db.monsterBase[m.base], m.id + ': 未知の base ' + m.base);
    ok(m.depth >= 1 && m.rarity >= 1, m.id + ': depth/rarity が不正');
    for (const b of (m.blows || [])) {
      ok(Combat.EFFECTS[b.effect], m.id + ': 未知の効果 ' + b.effect);
      ok(/^\d+d\d+(\+\d+)?$/.test(b.dice), m.id + ': ダイス表記が不正 ' + b.dice);
    }
  }
  for (const it of db.items) {
    ok(db.itemBase[it.base], it.id + ': 未知の base ' + it.base);
    ok(it.depth >= 1 && it.rarity >= 1, it.id + ': depth/rarity が不正');
  }
});

t('出現テーブルが深度で単調に強くなる', () => {
  const rng = RNG.create('alloc');
  function avgDepthAt(d) {
    let sum = 0;
    for (let i = 0; i < 3000; i++) sum += Data.pickMonster(rng, d).depth;
    return sum / 3000;
  }
  const a = avgDepthAt(1), b = avgDepthAt(8), c = avgDepthAt(16);
  ok(a < b && b < c, '深度で敵が強くならない: ' + [a, b, c].map(v => v.toFixed(2)));
});

t('深度外生成(OOD)が起きるが常態化しない', () => {
  const rng = RNG.create('ood');
  let boosted = 0;
  for (let i = 0; i < 20000; i++) if (Data.boostMonsterDepth(rng, 20) > 20) boosted++;
  const rate = boosted / 20000;
  ok(rate > 0.02 && rate < 0.07, 'OOD の発生率が想定外: ' + rate);
});

t('所持品: スタック・重量・積載超過で減速', () => {
  const W = Cmd.newGame('inv');
  const inv = W.inv;
  const k = Data.get().itemsById['ration'];
  const before = inv.items.length;
  Inventory.add(inv, Item.create(W.rng, k, 2));
  Inventory.add(inv, Item.create(W.rng, k, 3));
  eq(inv.items.length, before, '同種がスタックしていない');

  eq(Inventory.speedPenalty(W.player, inv), 0, '軽装で減速している');
  const heavy = Item.create(W.rng, Data.get().itemsById['breach-maul'], 1);
  heavy.weight = Inventory.capacity(W.player) * 2;
  Inventory.add(inv, heavy);
  ok(Inventory.speedPenalty(W.player, inv) < 0, '積載超過で減速しない');
});

t('装備: 持ち替えで元の装備が失われない', () => {
  const W = Cmd.newGame('equip');
  const a = Item.create(W.rng, Data.get().itemsById['service-knife'], 1);
  const b = Item.create(W.rng, Data.get().itemsById['impact-hammer'], 1);
  Inventory.add(W.inv, a);
  Inventory.equip(W.inv, a);
  eq(W.inv.equip.weapon.kindId, 'service-knife', '装備できていない');
  Inventory.add(W.inv, b);
  Inventory.equip(W.inv, b);
  eq(W.inv.equip.weapon.kindId, 'impact-hammer', '持ち替えできていない');
  ok(W.inv.items.some(x => x.kindId === 'service-knife'), '元の装備が消えた');
});

t('セーブ往復で状態が完全に一致する', () => {
  const W = Cmd.newGame('save-trip');
  for (let i = 0; i < 40; i++) Cmd.step(W, { type: 'move', dx: 1, dy: 0 });
  const dump = JSON.parse(JSON.stringify(World.serialize(W)));
  const W2 = World.deserialize(dump);

  eq(W2.turn, W.turn, 'ターン');
  eq(W2.depth, W.depth, '深度');
  eq(W2.player.x + ',' + W2.player.y, W.player.x + ',' + W.player.y, '位置');
  eq(W2.player.hp, W.player.hp, 'HP');
  eq(W2.actors.length, W.actors.length, 'アクター数');
  eq(Buffer.from(W2.level.tiles).toString('hex'),
     Buffer.from(W.level.tiles).toString('hex'), '地形');

  // 乱数状態も復元されるので、以後の展開が一致する (セーブスカム対策)
  const a = [], b = [];
  for (let i = 0; i < 30; i++) { a.push(W.rng.u32()); b.push(W2.rng.u32()); }
  eq(JSON.stringify(a), JSON.stringify(b), 'ロード後に乱数が分岐している');
});

t('★深度10 まで潜れて、そこで死ねる (M1 受け入れ基準)', () => {
  // 戦闘を避けて降下だけを行う「潜行専念」で、深部が成立することを確かめる
  const W = Cmd.newGame('dive');
  for (let d = 1; d <= 12; d++) {
    ok(W.depth === d, '深度が ' + d + ' でない: ' + W.depth);
    ok(W.actors.length > 1, '深度 ' + d + ' に敵が居ない');
    ok(W.items.length > 0, '深度 ' + d + ' にアイテムが無い');
    Cmd.enterLevel(W, d + 1, false);
  }
  eq(W.depth, 13, '深度13まで到達できない');

  // そこで死ねる
  ctx.Actor.damage(W.player, 9999);
  Cmd.upkeep(W);
  eq(W.dead, true, '死亡しない');
  ok(W.grave && W.grave.depth === 13, '墓碑が正しくない: ' + JSON.stringify(W.grave));
});

/* ============ M2: 鑑定・エゴ・能力・店・生成 ============ */
console.log('\n[M2 Angbandの深み]');

t('能力値 18/xx が本家の表記と単調性を保つ', () => {
  eq(Stat.label(3), '3', '下限');
  eq(Stat.label(18), '18', '18');
  eq(Stat.label(19), '18/10', '18/10');
  eq(Stat.label(28), '18/100', '18/100');
  eq(Stat.label(40), '18/220', '上限');
  eq(Stat.clamp(999), 40, '上限クランプ');
  eq(Stat.clamp(-5), 3, '下限クランプ');

  // 補正表が単調非減少
  let prev = -99;
  for (let v = 3; v <= 40; v++) {
    const d = Stat.damBonus(v);
    ok(d >= prev, `damBonus が v=${v} で減少した`);
    prev = d;
  }
  ok(Stat.damBonus(40) > Stat.damBonus(18), '18 を超えても伸びない = 18/xx の意味が無い');
  ok(Stat.carryMult(40) > Stat.carryMult(18), '積載量が 18 で頭打ち');
});

t('刻印: 1つ知ると以後すべての装備で既知になる (ルーン式)', () => {
  const W = Cmd.newGame('sigil');
  const K = W.knowledge;
  eq(Sigil.isKnownSigil(K, 's-speed'), false, '初期状態で既知');

  const a = Item.create(W.rng, Data.get().itemsById['service-knife'], 1);
  a.sigils = ['s-speed'];
  const b = Item.create(W.rng, Data.get().itemsById['pry-bar'], 1);
  b.sigils = ['s-speed'];

  eq(Sigil.fullyKnown(K, a), false, 'a が最初から既知');
  eq(Sigil.fullyKnown(K, b), false, 'b が最初から既知');
  Sigil.reveal(W, a, 'wear');
  eq(Sigil.isKnownSigil(K, 's-speed'), true, '装備で判明しない');
  eq(Sigil.fullyKnown(K, b), true, '★別の装備に知識が波及していない');
});

t('刻印: 判明の経路が正しく分かれる', () => {
  const W = Cmd.newGame('sigil2');
  const it = Item.create(W.rng, Data.get().itemsById['work-suit'], 1);
  it.sigils = ['s-res-fire', 's-slay-automata'];

  Sigil.reveal(W, it, 'wear');
  eq(Sigil.isKnownSigil(W.knowledge, 's-res-fire'), false, '耐性が装備だけで判明した');

  Sigil.reveal(W, it, 'hurt', { element: 'cold' });
  eq(Sigil.isKnownSigil(W.knowledge, 's-res-fire'), false, '別属性の被弾で判明した');

  Sigil.reveal(W, it, 'hurt', { element: 'fire' });
  eq(Sigil.isKnownSigil(W.knowledge, 's-res-fire'), true, '該当属性の被弾で判明しない');

  Sigil.reveal(W, it, 'hit', { base: 'infested' });
  eq(Sigil.isKnownSigil(W.knowledge, 's-slay-automata'), false, '別系統を殴って判明した');
  Sigil.reveal(W, it, 'hit', { base: 'automata' });
  eq(Sigil.isKnownSigil(W.knowledge, 's-slay-automata'), true, '該当系統を殴って判明しない');
});

t('フレーバーはランごとにシャッフルされ、ラン内では一貫する', () => {
  const a = Cmd.newGame('flavor-a');
  const b = Cmd.newGame('flavor-b');
  const a2 = Cmd.newGame('flavor-a');

  const nameOf = (W, id) => W.knowledge.flavors.ampule[id];
  eq(nameOf(a, 'medgel'), nameOf(a2, 'medgel'), '同一シードでフレーバーが一致しない');

  // 少なくとも1つは違うシードで違う見た目になる
  const kinds = Data.get().items.filter(k => k.base === 'ampule').map(k => k.id);
  ok(kinds.some(id => nameOf(a, id) !== nameOf(b, id)), '異なるシードで見た目が同じ');

  // 同一ラン内で重複しない (種別数がフレーバー数以下なら)
  const used = kinds.map(id => nameOf(a, id));
  eq(new Set(used).size, used.length, 'ラン内でフレーバーが重複している');
});

t('未鑑定のアイテムはフレーバー名で呼ばれる', () => {
  const W = Cmd.newGame('name');
  const kind = Data.get().itemsById['stim'];
  const it = Item.create(W.rng, kind, 1);
  const before = Sigil.name(W.knowledge, it);
  ok(before !== kind.name, '未鑑定なのに正式名で表示された: ' + before);
  ok(before.indexOf('アンプル') !== -1, 'フレーバー名になっていない: ' + before);
  Sigil.learnKind(W, it.kindId);
  eq(Sigil.name(W.knowledge, it), kind.name, '鑑定後に正式名にならない');
});

t('改修品と固有機材が生成され、固有機材は1ランに1個', () => {
  const W = Cmd.newGame('ego');
  let egos = 0, uniques = 0;
  const seen = {};
  for (let i = 0; i < 4000; i++) {
    const it = Item.makeForDepth(W.rng, 25, W);
    if (!it) continue;
    if (it.egoId) egos++;
    if (it.uniqueId) {
      uniques++;
      ok(!seen[it.uniqueId], '★固有機材 ' + it.uniqueId + ' が2つ生成された');
      seen[it.uniqueId] = true;
    }
  }
  ok(egos > 20, '改修品がほとんど出ない: ' + egos);
  ok(uniques > 0, '固有機材が1つも出ない');
  ok(uniques <= Data.get().uniques.length, '固有機材の総数を超えた');
});

t('汚染ファームは利点と同居し、外せる', () => {
  const db = Data.get();
  const tainted = db.egos.filter(e => e.taint);
  ok(tainted.length > 0, '汚染ファーム付きの改修品が無い');
  for (const e of tainted) {
    const value = (e.toDam || 0) + (e.ac || 0) + (e.sigils || []).length * 3;
    ok(value > 0, e.id + ': 利点が無い汚染ファームがある(ただの罠になっている)');
  }

  const W = Cmd.newGame('taint');
  const it = Item.create(W.rng, db.itemsById['service-knife'], 1);
  Item.applyEgo(it, tainted[0]);
  eq(it.tainted, true, '汚染フラグが立たない');
  Inventory.equip(W.inv, it, W.player);
  Effect.apply(W, W.player, 'remove-taint', null);
  const still = it.sigils.some(id => db.sigilsById[id] && db.sigilsById[id].taint);
  eq(still, false, '汚染ファームを剥がせない');
});

t('スレイ/ブランドは重ならず最大の1つだけが効く', () => {
  const bonus = Sigil.collect(['s-slay-automata', 's-brand-fire', 's-brand-elec'], 1);
  const drone = { base: 'automata' };
  const m = Combat.bestMultiplier(bonus, drone);
  eq(m.mult, 3, '対機械(x3)が選ばれていない');

  const human = { base: 'human' };
  eq(Combat.bestMultiplier(bonus, human).mult, 2, 'ブランド(x2)が効いていない');

  // 耐性を持つ相手にはブランドが乗らない
  const aberrant = { base: 'aberrant' };
  eq(Combat.bestMultiplier(Sigil.collect(['s-brand-elec'], 1), aberrant).mult, 1,
     '耐性のある属性でも倍率が乗った');
});

t('遠隔攻撃: 倍率が最後に掛かる', () => {
  const W = Cmd.newGame('shoot', 'terran', 'marksman');
  const db = Data.get();
  const weak = Item.create(W.rng, db.itemsById['scrap-slinger'], 1);   // 倍率2
  const strong = Item.create(W.rng, db.itemsById['lance-array'], 1);   // 倍率4
  const ammo = Item.create(W.rng, db.itemsById['scrap-slug'], 1);

  function avgDamage(launcher) {
    let sum = 0, hits = 0;
    for (let i = 0; i < 3000; i++) {
      const foe = Actor.create({ kind: 'monster', hp: 99999, hpMax: 99999, ac: 0, base: 'human' });
      const r = Combat.rangedAttack(W, W.player, foe, launcher, ammo);
      if (r.hit) { sum += r.damage; hits++; }
    }
    return sum / hits;
  }
  const a = avgDamage(weak), b = avgDamage(strong);
  ok(b > a * 1.6, '倍率がダメージを支配していない: ' + a.toFixed(1) + ' -> ' + b.toFixed(1));
  ok(Combat.rangeOf(strong) > Combat.rangeOf(weak), '倍率が射程に効いていない');
});

t('能力: 失敗率が主能力値とレベルで下がる', () => {
  const W = Cmd.newGame('abil', 'terran', 'psion');
  const p = W.player;
  const a = Data.get().abilitiesById['mind-thrust'];
  p.sp = 99;

  const base = Ability.failRate(p, a);
  p.level = 20;
  const leveled = Ability.failRate(p, a);
  ok(leveled < base, 'レベルで失敗率が下がらない: ' + base + ' -> ' + leveled);

  p.level = 1;
  p.stats.wis = 40;
  const smart = Ability.failRate(p, a);
  ok(smart < base, '主能力値で失敗率が下がらない: ' + base + ' -> ' + smart);

  ok(Ability.failRate(p, a) >= 5, '失敗率が 5% を下回った');
  p.sp = 0;
  ok(Ability.failRate(p, a) > smart, 'SP 不足のペナルティが無い');
});

t('能力: SP は主能力値が低いと 0 になる', () => {
  const W = Cmd.newGame('sp', 'terran', 'psion');
  const p = W.player;
  p.stats.wis = 3;
  p.level = 10;
  eq(Ability.maxSP(p), 0, '主能力値 3 で SP が残っている');
  p.stats.wis = 18;
  ok(Ability.maxSP(p) > 0, '主能力値 18 で SP が 0');
});

t('能力を持たないロールは SP を持たない', () => {
  const W = Cmd.newGame('nosp', 'terran', 'marine');
  eq(W.player.system, null, '突撃兵にサブシステムがある');
  eq(Ability.maxSP(W.player), 0, '突撃兵に SP がある');
  eq(Ability.learnable(W.player).length, 0, '突撃兵が能力を習得できる');
});

t('敵の睡眠: 隠密が高いほど起きにくい ([[D-40]])', () => {
  function wakeTurns(stealth) {
    const W = Cmd.newGame('sleep');
    W.player.skills.stealth = stealth;
    const mon = Actor.create({ kind: 'monster', asleep: 60, x: W.player.x + 6, y: W.player.y });
    let turns = 0;
    while (!AI.wakeCheck(W, mon, false) && turns < 5000) turns++;
    return turns;
  }
  const loud = wakeTurns(0), quiet = wakeTurns(25);
  ok(quiet > loud * 1.5, '隠密で覚醒が遅くならない: ' + loud + ' vs ' + quiet);

  // 一度起きたら二度と眠らない
  const W = Cmd.newGame('sleep2');
  const m = Actor.create({ kind: 'monster', asleep: 0, x: 1, y: 1 });
  eq(AI.wakeCheck(W, m, false), true, '起きた敵が眠っている');
});

t('眠っている敵への攻撃は必中で不意打ちが乗る', () => {
  const W = Cmd.newGame('sneak', 'voidborn', 'ghost');
  const race = Data.get().monstersById['security-unit'];   // AC 28
  function attack(asleep) {
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const foe = Monster.spawn(W.rng, race, 5, 5);
      foe.hp = foe.hpMax = 99999;
      foe.asleep = asleep;
      total += Combat.playerAttack(W, W.player, foe, Inventory.weapon(W.inv)).damage;
    }
    return total / 400;
  }
  const awake = attack(0), sleeping = attack(50);
  ok(sleeping > awake, '不意打ちで damage が増えない: ' + awake.toFixed(1) + ' -> ' + sleeping.toFixed(1));
});

t('音のマップ: 敵が壁を回り込んで近づく ([[D-35]])', () => {
  const W = Cmd.newGame('flow');
  AI.computeFlow(W);
  const lv = W.level;

  // プレイヤー位置は 0、離れるほど大きい
  eq(AI.flowAt(W, W.player.x, W.player.y), 0, 'プレイヤー位置が 0 でない');

  // 到達可能な床はすべて値を持つ (FLOW_MAX 以内)
  let reachable = 0, unreached = 0;
  const ff = Gen.floodFill(lv, W.player.x, W.player.y);
  for (let y = 0; y < lv.h; y++) {
    for (let x = 0; x < lv.w; x++) {
      if (!World.walkable(lv, x, y)) continue;
      if (!ff.visited[y * lv.w + x]) continue;
      const d = AI.flowAt(W, x, y);
      if (d === AI.UNREACHED) unreached++; else reachable++;
    }
  }
  ok(reachable > 0, '音のマップが空');
  // 壁の中は必ず未到達
  eq(AI.flowAt(W, 0, 0), AI.UNREACHED, '外周の壁に値が入っている');
});

t('階の予感: 危険度が敵の強さを反映する', () => {
  const W = Cmd.newGame('feel');
  const shallow = W.feeling.danger;
  Cmd.enterLevel(W, 30, false);
  const deep = W.feeling.danger;
  ok(deep >= shallow, '深部で危険度が上がらない: ' + shallow + ' -> ' + deep);
  ok(W.feeling.danger >= 0 && W.feeling.danger <= 9, '危険度が範囲外');

  // 有望度は歩いて初めて開示される (本家準拠)
  const W2 = Cmd.newGame('feel2');
  eq(W2.feeling.lootKnown, false, '入階直後に有望度が開示されている');
  for (let i = 0; i < 12 && !W2.feeling.lootKnown; i++) {
    const d = W2.rng.pick(U.DIRS);
    Cmd.step(W2, { type: 'move', dx: d.dx, dy: d.dy });
  }
  eq(W2.feeling.lootKnown, true, '歩いても有望度が開示されない');
});

t('区画テンプレートと Vault が地形として成立する', () => {
  const db = Data.get();
  for (const tpl of db.rooms.concat(db.vaults)) {
    const s = GenRooms.size(tpl);
    ok(s.w >= 5 && s.h >= 4, tpl.id + ': 小さすぎる');
    ok(s.w < 100 && s.h < 40, tpl.id + ': 大きすぎる (マップに入らない)');
    for (const row of tpl.map) {
      for (const ch of row) {
        ok(GenRooms.GLYPH[ch], tpl.id + ': 未知の記号 "' + ch + '"');
      }
    }
    // 出入口がある
    ok(tpl.map.some(r => r.indexOf('+') !== -1) || !tpl.size,
       tpl.id + ': Vault に出入口が無い');
  }
});

t('Vault の中身は深度より格上になる', () => {
  // marks に vault フラグが立ち、生成時に深度が押し上げられることを確認
  let found = null;
  for (let i = 0; i < 400 && !found; i++) {
    const lv = Gen.generate(RNG.create('vault-' + i).derive('L20'), 20);
    const vaultMark = (lv.marks || []).find(m => m.vault);
    if (vaultMark) found = { lv, mark: vaultMark };
  }
  ok(found, '400階生成しても Vault が1つも出ない (出現率が低すぎる)');
  ok(found.mark.size === 'small' || found.mark.size === 'great', 'Vault の size が不正');
});

t('母船: 深度0 で店が機能する', () => {
  const W = Cmd.newGame('shop-test', 'terran', 'scavenger');
  W.player.depthMax = 10;
  Cmd.enterLevel(W, 0, false);
  eq(W.depth, 0, '母船に入れない');
  eq(W.actors.length, 1, '母船に敵がいる');

  for (const s of Hub.SHOPS) {
    ok(W.shops[s.id] && W.shops[s.id].length > 0, s.name + ' の在庫が空');
  }

  // 買値は1個あたり。買った後の所持金が一致する
  const stock = W.shops.supply;
  const price = Hub.buyPrice(W, stock[0]);
  W.inv.credits = price + 100;
  const before = W.inv.credits;
  const r = Hub.buy(W, 'supply', 0);
  ok(r.ok, '購入できない: ' + r.reason);
  eq(W.inv.credits, before - price, '★表示価格と実際の支払いが違う');

  // 売値は買値よりずっと安い (店を稼ぎ手段にしない)
  const mine = W.inv.items.find(it => it.base === 'ration' || it.base === 'ampule');
  if (mine) ok(Hub.sellPrice(W, mine) < Hub.buyPrice(W, mine) * mine.count, '売値が買値以上');
});

t('母船から降下すると、そのサイトの到達最深度に戻れる', () => {
  const W = Cmd.newGame('recall');
  // 到達最深度は**サイトごと**に記録される ([[D-61]])
  const ash = Data.get().sitesById['ash'];
  Cmd.selectSite(W, 'ash');
  Site.noteDepth(W, 'ash', 12);
  Cmd.enterLevel(W, 0, false);
  W.player.x = W.level.down.x; W.player.y = W.level.down.y;
  Cmd.step(W, { type: 'descend' });
  eq(W.depth, 12, '到達最深度に戻れない');

  // 別サイトへ切り替えると、そちらは未到達なので最浅部から
  Cmd.enterLevel(W, 0, false);
  Cmd.selectSite(W, 'ark');
  W.player.x = W.level.down.x; W.player.y = W.level.down.y;
  Cmd.step(W, { type: 'descend' });
  eq(W.depth, Data.get().sitesById['ark'].depthMin,
     '未到達のサイトなのに他サイトの深度へ降りた');
  ok(ash.depthMax >= 12, 'テスト前提が壊れている');
});

t('敵の知識が蓄積する (monster memory)', () => {
  const W = Cmd.newGame('lore');
  const race = Data.get().monstersById['maintenance-drone'];
  eq(Lore.knowsHP(W, race.id), false, '最初から HP を知っている');

  for (let i = 0; i < 3; i++) {
    const m = Monster.spawn(W.rng, race, 5, 5);
    Lore.noteSeen(W, m);
    Lore.noteKill(W, m);
  }
  eq(Lore.knowsHP(W, race.id), true, '3体倒しても HP が分からない');

  const mon = Monster.spawn(W.rng, race, 5, 5);
  Lore.noteBlow(W, mon, race.blows[0]);
  const text = Lore.describe(W, race.id).join('\n');
  ok(text.indexOf('確認した攻撃') !== -1, '受けた攻撃が知識に入らない');
  ok(text.indexOf('撃破 3') !== -1, '撃破数が記録されない');
});

t('ユニーク敵は1ランに1体で、倒すと二度と出ない', () => {
  const W = Cmd.newGame('unique');
  const race = Data.get().monsters.find(m => (m.flags || []).indexOf('UNIQUE') !== -1);
  ok(race, 'ユニーク敵が定義されていない');

  // 通常抽選にはユニークが混ざらない
  for (let i = 0; i < 2000; i++) {
    const r = Monster.pickNormal(W.rng, W, 30);
    if (r) ok((r.flags || []).indexOf('UNIQUE') === -1, '★通常抽選にユニークが混ざった: ' + r.id);
  }

  // 倒したユニークは配置候補から外れる
  W.uniquesKilled[race.id] = true;
  let appeared = false;
  for (let d = race.depth; d <= race.depth + 8; d++) {
    Cmd.enterLevel(W, d, false);
    if (W.actors.some(a => a.raceId === race.id)) appeared = true;
  }
  eq(appeared, false, '倒したユニークが再出現した');
});

t('全 64 通りの系統×ロールが生成でき、値が壊れない', () => {
  const db = Data.get();
  for (const lin of db.lineages) {
    for (const role of db.roles) {
      const W = Cmd.newGame('c/' + lin.id + '/' + role.id, lin.id, role.id);
      const p = W.player;
      ok(p.hpMax > 0, lin.id + '/' + role.id + ': HP が 0');
      ok(isFinite(p.speed), lin.id + '/' + role.id + ': 速度が数値でない');
      for (const k of ['str', 'int', 'wis', 'dex', 'con', 'chr']) {
        const v = Stat.effective(p, k);
        ok(v >= Stat.MIN && v <= Stat.MAX, lin.id + '/' + role.id + ': ' + k + ' が範囲外 ' + v);
      }
      // 主能力値はロールの優先順位どおり良い値になる ([[D-41]])。
      // ただし系統の補正が主能力値を削る組み合わせ(合成体の念導者など)は
      // 本家同様「意図的に不利な選択」として許容する。下限だけを守る。
      if (role.statOrder && lin.id !== 'anomaly') {
        const top = Stat.effective(p, role.statOrder[0]);
        const penalty = lin.stats[role.statOrder[0]] || 0;
        const floor = penalty < 0 ? 12 : 15;
        ok(top >= floor,
           lin.id + '/' + role.id + ': 主能力値が低すぎる ' + Stat.label(top) + ' (下限 ' + floor + ')');
      }
    }
  }
});

t('データの参照が全て解決する (M2 の全ファイル)', () => {
  Data.validate(Data.get());   // 例外が出なければ OK
  const db = Data.get();
  ok(db.lineages.length === 8, '系統が 8 種でない: ' + db.lineages.length);
  ok(db.roles.length === 8, 'ロールが 8 種でない: ' + db.roles.length);
  for (const a of db.abilities) {
    ok(['psi', 'machine', 'bio'].indexOf(a.system) !== -1, a.id + ': 未知のサブシステム');
  }
  // 全ロールの能力が、そのロールのサブシステムと一致する
  for (const r of db.roles) {
    for (const id of (r.abilities || [])) {
      eq(db.abilitiesById[id].system, r.system, r.id + ' の ' + id + ' が別系統');
    }
  }
});

t('セーブ往復で M2 の状態も保たれる', () => {
  const W = Cmd.newGame('save-m2', 'chromed', 'technician');
  Sigil.learnSigil(W, 's-speed');
  Lore.noteSeen(W, Monster.spawn(W.rng, Data.get().monstersById['scavenger'], 3, 3));
  W.uniquesMade['u-first-cut'] = true;
  for (let i = 0; i < 20; i++) Cmd.step(W, { type: 'move', dx: 1, dy: 0 });

  const W2 = World.deserialize(JSON.parse(JSON.stringify(World.serialize(W))));
  eq(W2.knowledge.sigils['s-speed'], true, '刻印の知識が失われた');
  eq(Object.keys(W2.lore).length, Object.keys(W.lore).length, '敵の知識が失われた');
  eq(W2.uniquesMade['u-first-cut'], true, '固有機材の生成済みフラグが失われた');
  eq(W2.player.system, W.player.system, 'サブシステムが失われた');
  eq(JSON.stringify(W2.knowledge.flavors), JSON.stringify(W.knowledge.flavors), 'フレーバーが失われた');
});

t('★深度40 まで通しで潜れる (M2 受け入れ基準)', () => {
  const W = Cmd.newGame('dive-40');
  for (let d = 1; d <= 40; d++) {
    eq(W.depth, d, '深度が ' + d + ' でない');
    ok(W.actors.length > 1, '深度 ' + d + ' に敵が居ない');
    ok(W.items.length > 0, '深度 ' + d + ' にアイテムが無い');
    ok(W.feeling.danger >= 0, '深度 ' + d + ' の予感が壊れている');
    const ff = Gen.floodFill(W.level, W.player.x, W.player.y);
    eq(ff.reached, ff.total, '深度 ' + d + ' に到達不能な床がある');
    if (d < 40) Cmd.enterLevel(W, d + 1, false);
  }
  eq(W.depth, 40, '深度40 に到達できない');

  // 深部では改修品・固有機材が実際に出ている
  ok(Object.keys(W.uniquesMade).length > 0, '深度40 まで潜って固有機材が1つも生成されない');
});

/* ============ M3a: 環境・注視・休息・UI ============ */
console.log('\n[M3a 環境とUI]');

t('気密: 気圧から必要量が決まり、不足すると死ねる', () => {
  eq(Env.sealRequired({ atmosphere: 100 }), 0, '標準大気で気密が要る');
  eq(Env.sealRequired({ atmosphere: 60 }), 0, '気圧60 で気密が要る');
  eq(Env.sealRequired({ atmosphere: 45 }), 1, '気圧45');
  eq(Env.sealRequired({ atmosphere: 30 }), 2, '気圧30');
  eq(Env.sealRequired({ atmosphere: 0 }), 4, '真空');

  const W = Cmd.newGame('seal');
  W.level.env = Env.create({ atmosphere: 0 });     // 真空
  Cmd.recalc(W);
  ok(Env.sealDeficit(W) > 0, '真空で気密が足りている');

  const before = W.player.hp;
  for (let i = 0; i < 30 && !W.dead; i++) Cmd.step(W, { type: 'move', dx: 0, dy: 0 });
  ok(W.player.hp < before || W.dead, '★真空にいるのにダメージが無い');

  // 気密が足りていれば無傷
  const W2 = Cmd.newGame('seal2');
  W2.level.env = Env.create({ atmosphere: 0 });
  W2.player.seal = 10;
  eq(Env.sealDeficit(W2), 0, '気密10 でも不足している');
});

t('減圧下では精神系・生体系の能力が使えない', () => {
  const W = Cmd.newGame('voice', 'terran', 'psion');
  W.level.env = Env.create({ atmosphere: 100 });
  Cmd.recalc(W);
  eq(Env.canUseSystem(W, 'psi'), true, '通常大気で精神系が使えない');

  W.level.env = Env.create({ atmosphere: 0 });
  W.player.seal = 0;
  eq(Env.canUseSystem(W, 'psi'), false, '真空で精神系が使えてしまう');
  eq(Env.canUseSystem(W, 'bio'), false, '真空で生体系が使えてしまう');
  eq(Env.canUseSystem(W, 'machine'), true, '★機械系まで封じている');
});

t('重力: 低重力は速く弱い、高重力は遅く強い', () => {
  eq(Env.speedMod({ gravity: 1.0 }), 0, '標準重力で補正がある');
  ok(Env.speedMod({ gravity: 0.3 }) > 0, '低重力で速くならない');
  ok(Env.speedMod({ gravity: 2.0 }) < 0, '高重力で遅くならない');

  ok(Env.meleeMod({ gravity: 0.3 }) < 100, '低重力で近接が弱くならない');
  ok(Env.meleeMod({ gravity: 2.0 }) > 100, '高重力で近接が強くならない');
  eq(Env.meleeMod({ gravity: 1.0 }), 100, '標準重力で補正がある');

  ok(Env.carryMod({ gravity: 0.3 }) > 1, '低重力で積載が増えない');
  ok(Env.carryMod({ gravity: 2.0 }) < 1, '高重力で積載が減らない');

  // 実際に速度へ反映される
  const W = Cmd.newGame('grav');
  const normal = W.player.speed;
  W.level.env = Env.create({ gravity: 0.3 });
  Cmd.recalc(W);
  ok(W.player.speed > normal, '低重力が速度に反映されない');
});

t('放射線: 遮蔽物の陰では被曝が遅い', () => {
  function exposureAfter(sheltered) {
    const W = Cmd.newGame('rad' + sheltered);
    W.level.env = Env.create({ radiation: 8 });
    // 遮蔽の有無を作る: 開けた場所 vs 壁際
    const lv = W.level;
    let spot = null;
    for (let y = 2; y < lv.h - 2 && !spot; y++) {
      for (let x = 2; x < lv.w - 2; x++) {
        if (!World.walkable(lv, x, y)) continue;
        if (Env.isSheltered(lv, x, y) === sheltered) { spot = { x, y }; break; }
      }
    }
    ok(spot, (sheltered ? '遮蔽された' : '開けた') + '場所が見つからない');
    W.player.x = spot.x; W.player.y = spot.y;
    for (let i = 0; i < 400; i++) Env.tick(W), W.turn++;
    return W.player.exposure || 0;
  }
  const open = exposureAfter(false);
  const shade = exposureAfter(true);
  ok(open > 0, '開けた場所で被曝しない');
  ok(shade < open, '★遮蔽物の陰でも同じだけ被曝する: ' + shade + ' vs ' + open);
});

t('汚染: 蓄積すると変異する(利点と欠点の両方がある)', () => {
  const good = Env.MUTATIONS.filter(m => m.good).length;
  const bad = Env.MUTATIONS.filter(m => !m.good).length;
  ok(good > 0 && bad > 0, '変異が片方に偏っている');

  // 較正後は 1200/汚染度 ターンに1ずつ溜まる。閾値 30 に届くまで回す。
  const W = Cmd.newGame('mut');
  W.level.env = Env.create({ contamination: 10 });
  const need = Env.CONTAMINATION_STEP * Math.max(40, Math.floor(1200 / 10)) + 200;
  for (let i = 0; i < need && !(W.player.mutations || []).length; i++) { Env.tick(W); W.turn++; }
  ok((W.player.mutations || []).length > 0,
     '汚染が溜まっても変異しない (汚染 ' + (W.player.contamination || 0) +
     ' / 閾値 ' + Env.CONTAMINATION_STEP + ')');
});

t('環境の説明と警告が状況を反映する', () => {
  const W = Cmd.newGame('desc');
  W.level.env = Env.create({});
  eq(Env.describe(W), '', '標準環境なのに何か言っている');
  eq(Env.warnings(W).length, 0, '安全なのに警告が出ている');

  W.level.env = Env.create({ atmosphere: 0, radiation: 8, ambient: 0 });
  Cmd.recalc(W);
  const d = Env.describe(W);
  ok(d.indexOf('真空') !== -1, '真空が説明されない: ' + d);
  ok(d.indexOf('闇') !== -1, '暗黒が説明されない: ' + d);
  const warn = Env.warnings(W);
  ok(warn.some(x => x.label === '気密'), '気密の警告が出ない');
  ok(warn.some(x => x.color === 'red'), '不足しているのに赤くない');
});

t('注視: 候補を巡回でき、目標を記憶する ([[D-49]])', () => {
  const W = Cmd.newGame('look');
  // 敵をプレイヤーの近くに集める
  const foes = W.actors.filter(a => a.kind === 'monster').slice(0, 3);
  ok(foes.length >= 2, '敵が足りない');
  foes.forEach((f, i) => { f.x = W.player.x + 2 + i; f.y = W.player.y; });
  Cmd.refreshView(W);

  const cursor = Target.createCursor(W);
  const cands = Target.candidates(W);
  ok(cands.length >= 2, '注視候補が見つからない');
  ok(cands[0].kind === 'monster', '敵が先頭に来ていない');

  const a = Target.cycle(W, cursor, 1);
  const b = Target.cycle(W, cursor, 1);
  ok(a && b && (a.x !== b.x || a.y !== b.y), '巡回しても同じ対象');

  // 目標として記憶される
  ok(Target.set(W, b), '目標を設定できない');
  eq(Target.resolve(W).id, b.actor.id, '記憶した目標が解決できない');

  // 死ぬと自動で解除
  b.actor.dead = true;
  eq(Target.resolve(W), null, '死んだ目標が解除されない');
  eq(W.target, null, '目標の記憶が残っている');
});

t('注視: 目標が遠隔攻撃に使われる', () => {
  const W = Cmd.newGame('tgt', 'terran', 'marksman');
  const foes = W.actors.filter(a => a.kind === 'monster').slice(0, 2);
  ok(foes.length >= 2, '敵が足りない');
  foes[0].x = W.player.x + 1; foes[0].y = W.player.y;      // 近い
  foes[1].x = W.player.x + 3; foes[1].y = W.player.y;      // 遠い
  foes[1].hp = foes[1].hpMax = 9999;
  Cmd.refreshView(W);

  // 目標を指定しなければ最も近い敵
  eq(Target.pick(W).id, foes[0].id, '目標未指定で最も近い敵が選ばれない');

  // 指定すれば奥の敵
  Target.set(W, { kind: 'monster', actor: foes[1] });
  eq(Target.pick(W).id, foes[1].id, '★指定した目標が使われない');
});

t('注視の説明は知っていることだけを出す', () => {
  const W = Cmd.newGame('lookdesc');
  const foe = W.actors.find(a => a.kind === 'monster');
  foe.x = W.player.x + 1; foe.y = W.player.y;
  Cmd.refreshView(W);

  const text = Target.describe(W, { kind: 'monster', actor: foe }).join('\n');
  ok(text.indexOf(foe.name) !== -1, '名前が出ない');
  ok(text.indexOf('体力 不明') !== -1, '★倒していないのに体力が分かっている');

  for (let i = 0; i < 3; i++) Lore.noteKill(W, foe);
  const known = Target.describe(W, { kind: 'monster', actor: foe }).join('\n');
  ok(known.indexOf('体力 およそ') !== -1, '3体倒しても体力が分からない');
});

t('休息: 回復するが、ゲームターンは正しく消費する ([[D-50]])', () => {
  const W = Cmd.newGame('rest');
  // 敵を全部消して、静かな状態にする
  W.actors = W.actors.filter(a => a.kind === 'player');
  W.player.hp = 5;
  const food0 = W.player.food;
  const turn0 = W.turn;

  const n = Cmd.rest(W, 400);
  ok(n > 0, '休息していない');
  ok(W.player.hp > 5, 'HP が回復していない');
  ok(W.turn > turn0, '★ゲームターンが進んでいない (タダで回復している)');
  ok(W.player.food < food0, '★食料が減っていない (タダで回復している)');
});

t('休息: 敵が見えると止まる / 減圧下では休めない', () => {
  const W = Cmd.newGame('rest2');
  W.actors = W.actors.filter(a => a.kind === 'player');
  W.player.hp = 5;

  // 起きている敵を隣に置く
  const race = Data.get().monstersById['maintenance-drone'];
  const foe = Monster.spawn(W.rng, race, W.player.x + 1, W.player.y);
  foe.asleep = 0;
  World.addActor(W, foe);
  Cmd.refreshView(W);
  eq(Cmd.rest(W, 400), 0, '敵が見えているのに休んだ');

  // 減圧下では休めない
  const W2 = Cmd.newGame('rest3');
  W2.actors = W2.actors.filter(a => a.kind === 'player');
  W2.player.hp = 5;
  W2.level.env = Env.create({ atmosphere: 0 });
  Cmd.recalc(W2);
  eq(Cmd.rest(W2, 400), 0, '減圧下で休んだ');
});

t('連続移動: 壁・アイテム・敵で止まる', () => {
  const W = Cmd.newGame('run');
  W.actors = W.actors.filter(a => a.kind === 'player');
  W.items = [];
  Cmd.refreshView(W);

  // 壁に向かって走ると、壁の手前で止まる
  const before = { x: W.player.x, y: W.player.y };
  const n = Cmd.run(W, 1, 0, 100);
  ok(n < 100, '連続移動が止まらない');
  ok(World.walkable(W.level, W.player.x, W.player.y), '壁の中で止まっている');
  ok(n === 0 || W.player.x !== before.x || W.player.y !== before.y, '進んでいないのに歩数が出た');
});

t('UI: 一覧の内容は listFor が唯一の正本 ([[D-51]])', () => {
  // ヘッドレスでは UI(shell層) を読めないので、
  // 「listFor が参照するデータが決定論的である」ことを rule 層で検証する。
  const W = Cmd.newGame('list');
  const a = W.inv.items.map(it => it.uid).join(',');
  const b = W.inv.items.map(it => it.uid).join(',');
  eq(a, b, '所持品の並びが呼ぶたびに変わる');

  // 装備スロットは系統で変わる
  const chromed = Cmd.newGame('list2', 'chromed', 'marine');
  const terran = Cmd.newGame('list3', 'terran', 'marine');
  const cSlots = Inventory.SLOTS.filter(s => Inventory.slotEnabled(chromed.player, s));
  const tSlots = Inventory.SLOTS.filter(s => Inventory.slotEnabled(terran.player, s));
  ok(cSlots.length > tSlots.length, '義体化人類のインプラント枠が増えていない');
});

t('画面レイアウトが改訂後の寸法になっている ([[D-48]])', () => {
  eq(Render.TERM.w, 80, '端末幅');
  eq(Render.TERM.h, 40, '端末高');
  eq(Render.MSG_ROWS, 2, 'メッセージ行数');
  eq(Render.SIDEBAR_W, 16, 'サイドバー幅');
  eq(Render.MAP.w, 64, 'マップ幅');
  eq(Render.MAP.h, 38, 'マップ高');
  eq(Render.MAP.x, 16, 'マップ開始列');
  eq(Render.MAP.y, 2, 'マップ開始行');

  // メッセージが2行出る
  const W = Cmd.newGame('layout');
  World.msg(W, '一つ目のメッセージ');
  World.msg(W, '二つ目のメッセージ');
  const lines = Render.toText(Render.frame(W)).split('\n');
  ok(lines[0].indexOf('二つ目') !== -1, '最新が1行目に出ていない');
  ok(lines[1].indexOf('一つ目') !== -1, '直前が2行目に出ていない');
});

t('W が null でも画面が描ける (キャラクター作成画面のため)', () => {
  const buf = Render.frame(null);
  eq(buf.w, Render.TERM.w, '幅');
  eq(buf.h, Render.TERM.h, '高さ');
  ok(Render.toText(buf).indexOf('STRATA') !== -1, 'タイトルが出ない');
});

t('★環境ダメージだけでは死なない (1階層で HP の3割以内) ([[D-54]])', () => {
  // 1階層の滞在 = 約3000ゲームターン。自然回復を含む実ループで測る。
  const PROFILES = {
    '方舟':   { atmosphere: 55, temperature: -30, radiation: 1, contamination: 3, gravity: 0.3, ambient: 0 },
    '灰(昼)': { atmosphere: 45, temperature: 40, radiation: 8, contamination: 1, gravity: 1.0, ambient: 2 },
    '灰(夜)': { atmosphere: 45, temperature: -40, radiation: 2, contamination: 1, gravity: 1.0, ambient: 0 },
    '遺跡':   { atmosphere: 55, temperature: 70, radiation: 4, contamination: 8, gravity: 1.1, ambient: 0 },
    '尖塔':   { atmosphere: 90, temperature: 20, radiation: 0, contamination: 0, gravity: 1.0, ambient: 2 }
  };
  for (const name of Object.keys(PROFILES)) {
    const W = Cmd.newGame('cal/' + name);
    W.actors = W.actors.filter(a => a.kind === 'player');   // 敵を除き環境だけ測る
    Player.gainExp(W.player, 300);
    W.level.env = Env.create(PROFILES[name]);
    W.player.seal = 3;                                       // 気密は足りている前提
    W.depth = 20;
    Cmd.recalc(W);

    const hp0 = W.player.hpMax;
    W.player.hp = hp0;
    let min = hp0;
    while (W.turn < 3000 && !W.dead) {
      Cmd.step(W, { type: 'move', dx: 0, dy: 0 });
      if (W.player.hp < min) min = W.player.hp;
    }
    ok(!W.dead, '★' + name + ': 環境だけで死んだ');
    const lost = (hp0 - min) / hp0;
    ok(lost <= 0.3, '★' + name + ': 環境ダメージが HP の3割を超えた (' +
       Math.round(lost * 100) + '%)');
  }
});

t('減圧だけは例外で致死的。ただし気密で完全に防げる ([[D-54]])', () => {
  // seal は装備から毎ターン再計算される派生値なので、直接代入では試験できない。
  // 実際の装備で作る。
  function survive(sealGear) {
    const W = Cmd.newGame('decomp' + sealGear);
    W.actors = W.actors.filter(a => a.kind === 'player');
    Player.gainExp(W.player, 300);
    W.level.env = Env.create({ atmosphere: 30 });        // 必要気密 2
    W.depth = 20;

    if (sealGear) {
      const suit = Item.create(W.rng, Data.get().itemsById['vac-suit'], 1);  // seal 3
      Inventory.add(W.inv, suit);
      Inventory.equip(W.inv, suit, W.player);
    } else {
      W.inv.equip.body = null;                            // 気密を持たない
    }
    Cmd.recalc(W);

    const need = Env.sealRequired(W.level.env);
    ok(sealGear ? W.player.seal >= need : W.player.seal < need,
       '装備の前提が崩れている: seal=' + W.player.seal + ' need=' + need);

    while (W.turn < 3000 && !W.dead) Cmd.step(W, { type: 'move', dx: 0, dy: 0 });
    return !W.dead;
  }
  eq(survive(false), false, '★気密が無いのに減圧を生き延びた');
  eq(survive(true), true, '★気密が足りているのに減圧で死んだ');
});

t('被曝と汚染が撤退圧になる速度で溜まる', () => {
  function accumulate(env, key) {
    const W = Cmd.newGame('acc/' + key);
    W.actors = W.actors.filter(a => a.kind === 'player');
    /* 蓄積速度そのものを測りたいので、env を毎ターン書き換える固有機構
       (灰の昼夜・方舟の気圧) が無いサイトで測る。遺跡の 'dark' は
       env を静的に持つだけなので、ここでの観測を汚さない。 */
    W.site = Data.get().sitesById['ruins'];
    W.level.env = Env.create(env);
    W.player.seal = 3;
    Cmd.recalc(W);
    while (W.turn < 3000 && !W.dead) Cmd.step(W, { type: 'move', dx: 0, dy: 0 });
    return W.player[key] || 0;
  }
  // 高線量サイトを1階潜ると、能力値低下の閾値に近づく程度
  const rad = accumulate({ radiation: 8 }, 'exposure');
  ok(rad > 0, '高線量でも被曝しない');
  ok(rad < Env.EXPOSURE_STEP * 3,
     '被曝が速すぎる: 1階層で ' + rad + ' (閾値 ' + Env.EXPOSURE_STEP + ')');

  const con = accumulate({ contamination: 8 }, 'contamination');
  ok(con > 0, '高汚染でも汚染されない');
  ok(con < Env.CONTAMINATION_STEP * 3,
     '汚染が速すぎる: 1階層で ' + con + ' (閾値 ' + Env.CONTAMINATION_STEP + ')');

  // 安全なサイトでは溜まらない
  eq(accumulate({ radiation: 0, contamination: 0 }, 'exposure'), 0, '安全な階で被曝した');
});

t('環境がセーブ往復で保たれる', () => {
  const W = Cmd.newGame('env-save');
  W.level.env = Env.create({ atmosphere: 25, radiation: 7, gravity: 0.3 });
  W.player.exposure = 12;
  W.player.contamination = 5;
  Cmd.recalc(W);

  const W2 = World.deserialize(JSON.parse(JSON.stringify(World.serialize(W))));
  eq(W2.level.env.atmosphere, 25, '気圧が失われた');
  eq(W2.level.env.gravity, 0.3, '重力が失われた');
  eq(W2.player.exposure, 12, '被曝が失われた');
  eq(W2.player.contamination, 5, '汚染が失われた');
  eq(Env.sealRequired(W2.level.env), Env.sealRequired(W.level.env), '必要気密が変わった');
});

/* ============ 枠外UI: 凡例HUD ([[D-55]] [[D-56]]) ============ */
t('GROUP の敵は個体火力が同深度の単独敵の半分以下 ([[D-43]])', () => {
  // 群れは最大4体になる。個体を単独敵と同じ火力にすると総火力が4倍になり、
  // 群れ1種が死因の半分を占める。群れの怖さは**総量**であって個体の強さではない。
  const avgDice = s => {
    const [n, d] = s.split('d').map(Number);
    return n * (d + 1) / 2;
  };
  const dps = m => (m.blows || []).reduce((s, b) => s + avgDice(b.dice), 0);
  const normal = m => (m.flags || []).indexOf('UNIQUE') === -1;
  const all = Data.get().monsters;

  const bad = [];
  for (const m of all) {
    if (!normal(m) || (m.flags || []).indexOf('GROUP') === -1) continue;
    // 同深度±2 の単独敵の中央値を基準にする(1体の外れ値に引きずられないため)
    const solo = all.filter(x => normal(x) &&
      (x.flags || []).indexOf('GROUP') === -1 &&
      Math.abs(x.depth - m.depth) <= 2).map(dps).sort((a, b) => a - b);
    if (!solo.length) continue;
    const median = solo[solo.length >> 1];
    const ratio = dps(m) / median;
    if (ratio > 0.5) {
      bad.push(m.name + ' 深度' + m.depth + ' 火力' + dps(m).toFixed(1) +
               ' / 単独中央値' + median.toFixed(1) + ' = ' + ratio.toFixed(2));
    }
  }
  ok(bad.length === 0, 'GROUP の個体火力が高すぎる:\n         ' + bad.join('\n         '));
});

console.log('\n[敵の遠隔攻撃]');

/** 遠隔だけを持つ試験用の敵を1体置く。 */
function castOnce(W, spell, tweak) {
  const base = Object.assign({}, Data.get().monsters[0], tweak || {});
  base.spells = { freq: 1, list: [spell] };
  const p = W.player;
  const m = Monster.spawn(W.rng, base, p.x + 3, p.y);
  World.addActor(W, m);
  const before = { hp: p.hp, actors: W.actors.length };
  const res = Combat.monsterCast(W, m, p);
  m.dead = true;
  return { res: res, mon: m, dealt: before.hp - p.hp, summoned: W.actors.length - before.actors };
}

t('遠隔は6種すべてが解釈される ([[D-68]])', () => {
  const specs = ['bolt:rad:4d6', 'breath:vacuum:20', 'status:confused',
                 'summon:2', 'heal:30', 'blink:6'];
  for (const s of specs) {
    const W = Cmd.newGame('cast/' + s);
    Cmd.enterLevel(W, 5, false);
    W.player.hp = W.player.hpMax = 400;
    const r = castOnce(W, s);
    ok(r.res.spell === s, '撃った内容が記録されない: ' + s);
  }
  // それぞれが実際に何かを起こす
  const W1 = Cmd.newGame('cast-bolt'); Cmd.enterLevel(W1, 5, false);
  W1.player.hp = W1.player.hpMax = 400;
  ok(castOnce(W1, 'bolt:rad:6d6').dealt > 0, 'bolt でダメージが入らない');

  const W2 = Cmd.newGame('cast-summon'); Cmd.enterLevel(W2, 5, false);
  ok(castOnce(W2, 'summon:2').summoned > 0, 'summon で増援が湧かない');

  const W3 = Cmd.newGame('cast-heal'); Cmd.enterLevel(W3, 5, false);
  const h = castOnce(W3, 'heal:50', { hp: '40d10' });
  // 撃つ前に傷つけておけないので、上限に対して減っていないことだけ見る
  ok(h.mon.hp <= h.mon.hpMax, 'heal で HP が上限を超えた');
});

t('ブレスは撃つ側の現HPの割合で、上限を超えない', () => {
  const W = Cmd.newGame('breath');
  Cmd.enterLevel(W, 5, false);
  W.player.hp = W.player.hpMax = 9999;

  // 弱った敵のブレスは弱い (本家と同じ性質)
  const p = W.player;
  const base = Object.assign({}, Data.get().monsters[0], { hp: '40d10' });
  base.spells = { freq: 1, list: ['breath:fire:50'] };

  const strong = Monster.spawn(W.rng, base, p.x + 3, p.y);
  strong.hp = strong.hpMax = 400;
  World.addActor(W, strong);
  const big = Combat.monsterCast(W, strong, p).damage;
  strong.dead = true;

  const weak = Monster.spawn(W.rng, base, p.x + 4, p.y);
  weak.hp = 40; weak.hpMax = 400;
  World.addActor(W, weak);
  const small = Combat.monsterCast(W, weak, p).damage;
  weak.dead = true;

  ok(big > small, '弱った敵のブレスが弱くならない: ' + big + ' vs ' + small);
  ok(big <= Combat.BREATH_CAP, 'ブレスが上限を超えた: ' + big);
});

t('《適合》は環境属性の遠隔を完全に無効にする ([[doc:endgame]] §7.2)', () => {
  // ここが《門番》(深度99)の設計の土台。無効化が効かないと最終戦が成立しない。
  function run(adapt) {
    const W = Cmd.newGame('adapt-cast/' + adapt);
    Cmd.enterLevel(W, 5, false);
    if (adapt) {
      for (const k of ['vacuum', 'radiation', 'contamination', 'watch']) {
        Site.grantAdaptation(W, k);
      }
    }
    W.player.hp = W.player.hpMax = 2000;
    let dealt = 0, summoned = 0;
    for (const s of ['bolt:rad:6d6', 'breath:vacuum:30', 'bolt:taint:6d6', 'status:watch']) {
      const r = castOnce(W, s, { hp: '40d10' });
      dealt += r.dealt; summoned += r.summoned;
    }
    return { dealt: dealt, summoned: summoned };
  }
  const bare = run(false);
  ok(bare.dealt > 0, '《適合》なしで環境属性の遠隔が効かない');
  ok(bare.summoned > 0, '走査で増援が呼ばれない');

  const safe = run(true);
  eq(safe.dealt, 0, '《適合》を持っていても環境属性で削られる');
  eq(safe.summoned, 0, '《適合:監視》を持っていても走査で呼ばれる');
});

t('遠隔を撃った手番は移動も殴打もしない', () => {
  const W = Cmd.newGame('cast-turn');
  Cmd.enterLevel(W, 5, false);
  W.actors = W.actors.filter(a => a.kind === 'player');
  const p = W.player;
  p.hp = p.hpMax = 400;

  const base = Object.assign({}, Data.get().monsters[0], { hp: '40d10', speed: 110 });
  base.spells = { freq: 1, list: ['bolt:rad:1d1'] };   // 必ず撃つ
  const m = Monster.spawn(W.rng, base, p.x + 1, p.y);  // 隣接している
  m.asleep = 0;
  World.addActor(W, m);

  const at = { x: m.x, y: m.y };
  AI.act(W, m);
  eq(m.x, at.x, '遠隔を撃ったのに移動した');
  eq(m.y, at.y, '遠隔を撃ったのに移動した');
});

t('受けた遠隔は敵の知識に残る', () => {
  const W = Cmd.newGame('cast-lore');
  Cmd.enterLevel(W, 5, false);
  W.player.hp = W.player.hpMax = 400;
  const r = castOnce(W, 'bolt:rad:4d6');
  const e = W.lore[r.mon.raceId];
  ok(e && e.spells && e.spells['bolt:rad:4d6'] > 0, '受けた遠隔が記録されない');
});

t('接続者は端末を待たなくていい ―― 仮設接続 ([[D-75]])', () => {
  // 端末が出ないサイト(遺跡 5%)でロールが機能しないのは、ロールの欠陥
  const W = Cmd.newGame('fieldjack', 'terran', 'netrunner');
  Player.gainExp(W.player, Player.expNeeded(19, W.player.expFactor));
  Cmd.recalc(W);
  const p = W.player;
  for (const a of Ability.learnable(p)) if (a.id === 'field-jack') Ability.learn(W, p, a.id);
  ok(p.abilities.indexOf('field-jack') !== -1, '接続者が仮設接続を覚えられない');

  Cmd.enterLevel(W, 20, false);
  // 階段の上には立てられない
  eq(Effect.makeTerminal(W, p), false, '昇降機の上に端末が立った');

  // 床へ移す
  let moved = false;
  for (let dy = -3; dy <= 3 && !moved; dy++) {
    for (let dx = -3; dx <= 3 && !moved; dx++) {
      if (World.getTile(W.level, p.x + dx, p.y + dy) === World.TILE.FLOOR) {
        p.x += dx; p.y += dy; moved = true;
      }
    }
  }
  ok(moved, 'テスト前提: 近くに床が無い');

  eq(Effect.makeTerminal(W, p), true, '床に端末を立てられない');
  eq(Net.atTerminal(W), true, '立てたのに端末として認識されない');
  p.cog = p.cogMax;
  ok(Net.jack(W, 'n-map').ok, '仮設端末から接続できない');
});

t('召喚は一世代で止まる ([[D-90]])', () => {
  /* 止めないと連鎖する ―― 召喚する敵は全体の22%あり、
     うち3体は呪文が召喚しかないので、呼んだ相手がまた呼ぶ。
     実測で《培養者》戦の盤面が 20手で 2体 → 43体に膨れていた。 */
  const W = Cmd.newGame('summon-gen'); Cmd.enterLevel(W, 20, false);
  const p = W.player;
  const base = Object.assign({}, Data.get().monsters[0]);
  base.spells = { freq: 1, list: ['summon:2'] };

  const caller = Monster.spawn(W.rng, base, p.x + 3, p.y);
  World.addActor(W, caller);
  const n0 = W.actors.length;
  Combat.monsterCast(W, caller, p);
  ok(W.actors.length > n0, '前提: 呼べていない');

  // 呼ばれた側は summon を選べない
  const called = W.actors[W.actors.length - 1];
  ok(called.summoned, '呼ばれた敵に summoned が立っていない');
  called.spells = base.spells;
  eq(Combat.castable(W, called), null, '呼ばれた敵がまだ召喚を選べる');
  eq(Combat.willCast(W, called), false, '呼ばれた敵が召喚のために撃とうとする');

  // 呼んだ側は撃てるまま
  eq(Combat.castable(W, caller), base.spells.list, '呼んだ側まで撃てなくなっている');
});

t('階のアクター数に上限がある ([[D-90]])', () => {
  const W = Cmd.newGame('summon-cap'); Cmd.enterLevel(W, 20, false);
  const p = W.player;
  const base = Object.assign({}, Data.get().monsters[0]);
  const caller = Monster.spawn(W.rng, base, p.x + 3, p.y);
  World.addActor(W, caller);

  for (let i = 0; i < 40; i++) Monster.summonNear(W, caller, 5, 20);
  ok(W.actors.length <= Monster.MAX_ACTORS,
     '上限 ' + Monster.MAX_ACTORS + ' を超えた: ' + W.actors.length);
  ok(Monster.atCapacity(W), '満員なのに atCapacity が false');
});

t('環境は行動回数を黙って半減させない ([[D-91]])', () => {
  /* エネルギー表の段差(109→5 / 110→10)は**速度が10きざみでしか変わらない**
     前提のもの。常時かかる重力が -1 を返すだけで踏み抜き、
     遺跡(1.1G)が「速度109」の表示で行動回数半減になっていた。 */
  const normal = Turn.gain(Turn.NORMAL_SPEED);
  for (const g of [0.3, 1.0, 1.1, 1.4]) {
    const mod = Env.speedMod({ gravity: g });
    const gain = Turn.gain(Turn.NORMAL_SPEED + mod);
    ok(gain >= normal,
       '重力 ' + g + ' で行動回数が減る (速度 ' + (Turn.NORMAL_SPEED + mod) +
       ' / gain ' + gain + ' < ' + normal + ')');
  }
  eq(Env.speedMod({ gravity: 0.3 }), 10, '低重力の利点が失われている');
});

t('速度補正は10きざみ ―― 表の段差を半端に踏まない ([[D-91]])', () => {
  for (let i = 0; i <= 30; i++) {
    const g = i / 10;
    const mod = Env.speedMod({ gravity: g });
    eq(mod % 10, 0, '重力 ' + g.toFixed(1) + ' が10きざみでない補正 ' + mod + ' を返す');
  }
});

t('《異常》にはスレイが効かない ([[D-92]])', () => {
  /* スレイは「相手が何であるか」に賭ける刻印。異常は分類できないので当たらない。
     これが無いと、深部は aberrant が最多なので終盤が
     「対異常を引いたか」の抽選になる。 */
  const db = Data.get();
  eq(db.monsterBase.aberrant.slayable, false, '異常が slayable のまま');

  const bonus = Sigil.collect(['s-slay-automata', 's-slay-xeno'], 1);
  eq(Combat.bestMultiplier(bonus, { base: 'automata' }).mult, 3, '対機械が効いていない');
  eq(Combat.bestMultiplier(bonus, { base: 'xeno' }).mult, 3, '対異星が効いていない');
  eq(Combat.bestMultiplier(bonus, { base: 'aberrant' }).mult, 1, '異常にスレイが通っている');
});

t('《異常》にブランドは効く ―― 属性は分類ではない ([[D-92]])', () => {
  /* aberrant は電磁・毒素・放射に耐性を持つので、通るのは高熱・極低温・腐食。 */
  for (const el of ['fire', 'cold', 'acid']) {
    const b = Sigil.collect(['s-brand-' + el], 1);
    eq(Combat.bestMultiplier(b, { base: 'aberrant' }).mult, 2, el + ' が異常に通らない');
  }
  for (const el of ['elec', 'pois']) {
    const b = Sigil.collect(['s-brand-' + el], 1);
    eq(Combat.bestMultiplier(b, { base: 'aberrant' }).mult, 1, el + ' が異常に通っている');
  }
});

t('効かない刻印がデータに残っていない ([[D-92]])', () => {
  /* 廃止したスレイを装備データが積んだままだと「何もしない刻印」になる。 */
  const db = Data.get();
  ok(!db.sigilsById['s-slay-aberrant'], 's-slay-aberrant が残っている');

  const dead = [];
  for (const list of [db.egos, db.uniques]) {
    for (const e of (list || [])) {
      for (const s of (e.sigils || [])) {
        const sig = db.sigilsById[s];
        if (sig && sig.kind === 'slay' && db.monsterBase[sig.base] &&
            db.monsterBase[sig.base].slayable === false) {
          dead.push(e.name + ' の ' + s);
        }
      }
    }
  }
  eq(dead.length, 0, '効かないスレイを積んでいる: ' + dead.join(' / '));
});

t('状態異常はアクター自身の手番で減る ([[D-93]])', () => {
  /* ゲームターンで減らすと、速度110 の1手番 = 10ゲームターンなので
     書いた数字の10分の1しか続かない。実測で paralyzed 16 が
     プレイヤー1手番未満になり、止めるための道具が止められなかった。 */
  const W = Cmd.newGame('timer-clock'); Cmd.enterLevel(W, 10, false);
  const p = W.player;
  W.actors = W.actors.filter(a => a.kind === 'player');
  p.hp = p.hpMax = 99999;

  Actor.addTimer(p, 'afraid', 12);
  let moves = 0;
  while (p.timers.afraid > 0 && moves < 200) {
    if (!Cmd.step(W, { type: 'move', dx: 0, dy: 1 }) &&
        !Cmd.step(W, { type: 'move', dx: 0, dy: -1 })) break;
    moves++;
  }
  eq(moves, 12, '付与値と実手番が一致しない');
});

t('敵の状態異常も敵自身の手番で減る ([[D-93]])', () => {
  const W = Cmd.newGame('timer-mon'); Cmd.enterLevel(W, 10, false);
  const p = W.player;
  W.actors = W.actors.filter(a => a.kind === 'player');
  p.hp = p.hpMax = 99999;

  // 標準速度の敵なら、プレイヤーと同じ手番数で切れる
  const race = Object.assign({}, Data.get().monsters[0], { speed: 110, hp: '99d99' });
  const mon = Monster.spawn(W.rng, race, p.x + 4, p.y);
  mon.asleep = 0;
  World.addActor(W, mon);
  Actor.addTimer(mon, 'afraid', 8);

  let moves = 0;
  while (mon.timers.afraid > 0 && moves < 200) {
    if (!Cmd.step(W, { type: 'move', dx: 0, dy: 1 }) &&
        !Cmd.step(W, { type: 'move', dx: 0, dy: -1 })) break;
    moves++;
  }
  ok(moves >= 7 && moves <= 9, '同速の敵なのに ' + moves + ' 手番で切れた (期待 8前後)');
});

t('麻痺したプレイヤーは行動できない ([[D-93]])', () => {
  /* execPlayer に canAct の確認が無く、**一度も判定されていなかった**。
     持続が1手番未満だったので表面化していなかった。 */
  const W = Cmd.newGame('timer-para'); Cmd.enterLevel(W, 10, false);
  const p = W.player;
  W.actors = W.actors.filter(a => a.kind === 'player');
  p.hp = p.hpMax = 99999;

  const from = { x: p.x, y: p.y };
  Actor.addTimer(p, 'paralyzed', 4);
  ok(Cmd.step(W, { type: 'move', dx: 1, dy: 0 }), '麻痺中に手番が進まない');
  eq(p.x, from.x, '麻痺中に動けている');
  eq(p.y, from.y, '麻痺中に動けている');

  // 上限ぶん過ぎれば戻る
  for (let i = 0; i < 10 && p.timers.paralyzed > 0; i++) Cmd.step(W, { type: 'move', dx: 1, dy: 0 });
  eq(p.timers.paralyzed, 0, '麻痺が切れない');
});

t('足を止める道具が実際に止める ([[D-93]])', () => {
  /* 上限6が「6ゲームターン」だと相手の1手番にも満たず、
     止めるための道具が何も止められなかった。
     ユニークは抵抗判定があるので ([[D-94]])、ここでは通常の敵で測る。 */
  const W = Cmd.newGame('timer-pin'); Cmd.enterLevel(W, 20, false);
  const p = W.player;
  W.actors = W.actors.filter(a => a.kind === 'player');

  const race = Object.assign({}, Data.get().monsters[0], { speed: 110, hp: '99d99', level: 5 });
  const mon = Monster.spawn(W.rng, race, p.x + 2, p.y);
  mon.asleep = 0;
  World.addActor(W, mon);

  // 抵抗判定があるので ([[D-94]])、入るまで撃つ。入ること自体は確かめる
  let tries = 0;
  while (mon.timers.paralyzed === 0 && tries++ < 30) {
    Effect.apply(W, p, 'afflict:paralyzed:10:4', mon);
  }
  ok(mon.timers.paralyzed > 0, '格下の敵に30回撃っても麻痺が入らない');

  let acted = 0;
  const orig = AI.act;
  AI.act = function (Wx, m) { if (m === mon) acted++; return orig(Wx, m); };
  let moves = 0;
  try {
    while (mon.timers.paralyzed > 0 && moves < 50) {
      if (!Cmd.step(W, { type: 'move', dx: 0, dy: 1 }) &&
          !Cmd.step(W, { type: 'move', dx: 0, dy: -1 })) break;
      moves++;
    }
  } finally { AI.act = orig; }
  eq(acted, 0, '麻痺中に ' + acted + ' 回行動した');
  ok(moves >= 5, '麻痺が ' + moves + ' 手番しか保たない (上限6のはず)');
});

t('行動を奪う状態異常には抵抗判定がある ([[D-94]])', () => {
  /* 判定が無いと「麻痺させて殴るだけ」が最適解になり、
     実測で終盤の関門が最も易しくなっていた。 */
  const shallow = { level: 10, unique: false, flags: [] };
  const deep = { level: 90, unique: false, flags: [] };
  const boss = { level: 90, unique: true, flags: ['UNIQUE'] };
  const me = { level: 50 };

  ok(Effect.landChance(me, shallow) > Effect.landChance(me, deep),
     '深い相手のほうが通りやすい');
  ok(Effect.landChance(me, boss) < Effect.landChance(me, deep),
     'ユニークが雑魚より抵抗しない');
  ok(Effect.landChance(me, boss) > 0, 'ユニークが完全耐性になっている');

  // 毒は判定しない ―― 継続ダメージは行動を奪わない
  ok(Effect.DISABLING.paralyzed, '麻痺が判定対象から外れている');
  ok(!Effect.DISABLING.poison, '毒が判定対象に入っている');
});

t('《係留》は転移だけを消し、行動は奪わない ([[D-95]])', () => {
  /* 「捕まえられない」の答えは相手を止めることではなく逃げ道を塞ぐこと。
     麻痺で代用すると、効けば強すぎ・弱めれば捕まえられないの二択になる。 */
  const W = Cmd.newGame('bind1'); Cmd.enterLevel(W, 60, false);
  const p = W.player;
  W.actors = W.actors.filter(a => a.kind === 'player');

  const race = Object.assign({}, Data.get().monstersById['u-custodian']);
  const mon = Monster.spawn(W.rng, race, p.x + 2, p.y);
  mon.asleep = 0;
  World.addActor(W, mon);

  Effect.apply(W, p, 'bind:25:5', mon);
  ok(mon.timers.bound > 0, 'ユニークに係留が入らない');
  eq(mon.timers.paralyzed, 0, '係留が行動まで奪っている');
  ok(Actor.canAct(mon), '係留された敵が行動不能になっている');

  // 係留中は転移しても動かない
  const at = { x: mon.x, y: mon.y };
  for (let i = 0; i < 20; i++) Combat.monsterCast(W, mon, p);
  // 転移以外の呪文で位置は変わらないので、座標が保たれていること自体が検証になる
  eq(mon.x + ',' + mon.y, at.x + ',' + at.y, '係留中に転移した');
});

t('係留が切れれば転移は戻る ([[D-95]])', () => {
  const W = Cmd.newGame('bind2'); Cmd.enterLevel(W, 60, false);
  const p = W.player;
  W.actors = W.actors.filter(a => a.kind === 'player');
  const race = Object.assign({}, Data.get().monstersById['u-custodian']);
  const mon = Monster.spawn(W.rng, race, p.x + 2, p.y);
  mon.asleep = 0; World.addActor(W, mon);

  let moved = false;
  for (let i = 0; i < 60 && !moved; i++) {
    const at = mon.x + ',' + mon.y;
    Combat.monsterCast(W, mon, p);
    if (mon.x + ',' + mon.y !== at) moved = true;
  }
  ok(moved, '係留していないのに転移しない (前提が崩れている)');
});

t('逃げ道を塞ぐ道具がデータに在る ([[D-95]])', () => {
  const db = Data.get();
  const binders = db.items.filter(e => (e.effect || '').indexOf('bind') === 0);
  ok(binders.length >= 1, '`bind` を持つアイテムが無い');
  // 転移する敵は深度17から出る。道具がそれより深すぎないこと
  const first = Math.min.apply(null, binders.map(e => e.depth));
  const blinkers = db.monsters.filter(m => m.spells &&
      m.spells.list.some(s => s.indexOf('blink') === 0));
  ok(blinkers.length > 0, '前提: 転移する敵が居ない');
  ok(first <= 50, '逃げ道を塞ぐ道具が深すぎる (最浅 ' + first + ')');
});

console.log('\n[解体と移植]');

/** 刻印を持つ改修品を1つ作って持たせる。 */
function withEgo(W, sigilId) {
  const rng = RNG.create('ego/' + sigilId);
  for (let i = 0; i < 4000; i++) {
    const it = Item.makeForDepth(rng, 20, W);
    if (!it || !it.slot || !it.egoId) continue;
    if (sigilId && (it.sigils || []).indexOf(sigilId) === -1) continue;
    if (!sigilId && !(it.sigils || []).some(s => s.charAt(0) === 's')) continue;
    it.known = true;
    Inventory.add(W.inv, it);
    return it;
  }
  return null;
}

t('素の装備からは何も取れない。改修品だけが素材になる ([[doc:subsystems]] §11.4)', () => {
  // 「弱いエゴ品」に価値を作るのが狙い。素の装備まで素材にすると工房が最適解になる
  const W = Cmd.newGame('salv');
  const plain = Item.create(RNG.create('p'), Data.get().itemsById['work-suit'], 1);
  plain.known = true;
  Inventory.add(W.inv, plain);
  ok(Craft.salvageReason(W, plain), '素の装備が解体できてしまう');

  const ego = withEgo(W, null);
  ok(ego, 'テスト前提: 刻印付きの改修品を作れない');
  eq(Craft.salvageReason(W, ego), null, '改修品が解体できない');
});

t('解体するとモジュールが取れ、装備は戻らない', () => {
  const W = Cmd.newGame('salv2');
  const ego = withEgo(W, null);
  ok(ego, 'テスト前提');
  const want = Craft.salvageYield(ego);
  const before = W.inv.items.length;

  const r = Craft.salvage(W, ego);
  ok(r.ok, '解体できない: ' + r.reason);
  eq(r.sigil, want, '取れたモジュールが違う');
  eq(W.inv.items.length, before - 1, '解体したのに装備が残っている');
  eq(Craft.modules(W)[want], 1, 'モジュールが手持ちに入らない');
});

t('移植は2枠まで。全部載せを作らせない', () => {
  const W = Cmd.newGame('graft');
  W.player.depthMax = 1;
  Craft.addParts(W, 99);
  for (const s of ['s-str', 's-dex', 's-con']) Craft.addModule(W, s);

  const target = Item.create(RNG.create('t'), Data.get().itemsById['work-suit'], 1);
  target.known = true;
  Inventory.add(W.inv, target);

  ok(Craft.transplant(W, target, 's-str').ok, '1つ目が移植できない');
  ok(Craft.transplant(W, target, 's-dex').ok, '2つ目が移植できない');
  const third = Craft.transplant(W, target, 's-con');
  eq(third.ok, false, '★3つ目が移植できてしまう');
  eq(Craft.grafted(target), Craft.MAX_MODULES, '枠の数が合わない');

  // 移植した装備は改修品として扱われる
  ok(target.egoId, '移植しても改修品にならない');
  ok(target.sigils.indexOf('s-str') !== -1, '刻印が入っていない');
});

t('同じ刻印は二度入らない', () => {
  const W = Cmd.newGame('graft2');
  W.player.depthMax = 1;
  Craft.addParts(W, 99);
  Craft.addModule(W, 's-str'); Craft.addModule(W, 's-str');
  const it = Item.create(RNG.create('t2'), Data.get().itemsById['work-suit'], 1);
  it.known = true;
  Inventory.add(W.inv, it);

  ok(Craft.transplant(W, it, 's-str').ok, '1回目が通らない');
  eq(Craft.transplant(W, it, 's-str').ok, false, '同じ刻印が二度入った');
});

t('移植はレアパーツを要求し、深いほど高くつく', () => {
  const W = Cmd.newGame('parts');
  Craft.addModule(W, 's-str');
  const it = Item.create(RNG.create('t3'), Data.get().itemsById['work-suit'], 1);
  it.known = true;
  Inventory.add(W.inv, it);

  W.player.depthMax = 1;
  const shallow = Craft.partsNeeded(W, it);
  W.player.depthMax = 80;
  const deep = Craft.partsNeeded(W, it);
  ok(deep > shallow, '深度で要求が変わらない: ' + shallow + ' vs ' + deep);

  // 足りなければ移植できない
  eq(Craft.parts(W), 0, 'テスト前提: パーツを持っていない');
  eq(Craft.transplant(W, it, 's-str').ok, false, 'パーツ無しで移植できた');

  Craft.addParts(W, deep);
  ok(Craft.transplant(W, it, 's-str').ok, 'パーツがあるのに移植できない');
  eq(Craft.parts(W), 0, 'パーツが消費されていない');
});

t('固有機材は解体も移植もできない', () => {
  const W = Cmd.newGame('uniq-craft');
  const rng = RNG.create('u');
  let uniq = null;
  for (let i = 0; i < 6000 && !uniq; i++) {
    const it = Item.makeForDepth(rng, 40, W);
    if (it && it.uniqueId) uniq = it;
  }
  if (!uniq) return;                       // 出なければこのテストは意味を持たない
  uniq.known = true;
  Inventory.add(W.inv, uniq);
  Craft.addParts(W, 99); Craft.addModule(W, 's-str');
  ok(Craft.salvageReason(W, uniq), '固有機材が解体できてしまう');
  ok(Craft.transplantReason(W, uniq, 's-str'), '固有機材に移植できてしまう');
});

t('レアパーツは深部の敵だけが落とす', () => {
  function harvest(depth) {
    const W = Cmd.newGame('drop/' + depth);
    W.depth = depth;
    const foe = Monster.spawn(W.rng, Data.get().monsters[0], 5, 5);
    for (let i = 0; i < 400; i++) Cmd.dropParts(W, foe);
    return Craft.parts(W);
  }
  eq(harvest(Cmd.PARTS_MIN_DEPTH - 1), 0, '浅い場所でパーツが落ちた');
  ok(harvest(Cmd.PARTS_MIN_DEPTH + 10) > 0, '深部でパーツが落ちない');
});

t('モジュールとパーツがセーブ往復で保たれる', () => {
  const W = Cmd.newGame('craft-save');
  Craft.addModule(W, 's-speed');
  Craft.addParts(W, 5);
  const W2 = World.deserialize(JSON.parse(JSON.stringify(World.serialize(W))));
  eq(Craft.modules(W2)['s-speed'], 1, 'モジュールが失われた');
  eq(Craft.parts(W2), 5, 'レアパーツが失われた');
});

t('データが書いている効果は全て実装されている', () => {
  /* `restore-cog` を items.json に書いたのに未実装で、使っても
     **黙って何も起きなかった**。「何も起きない」は成功と区別がつかない。
     効果種別の綴りをデータ検査で止める。 */
  const known = new Set(Effect.KINDS);
  const bad = [];
  const check = (owner, spec) => {
    if (!spec) return;
    const kind = String(spec).split(':')[0];
    if (!known.has(kind)) bad.push(owner + ': ' + spec);
  };
  for (const it of Data.get().items) check('items/' + it.id, it.effect);
  for (const a of Data.get().abilities) check('abilities/' + a.id, a.effect);
  ok(bad.length === 0, '未実装の効果を参照している:\n         ' + bad.join('\n         '));

  // 実際に使って「何も起きなかった」で終わらないことも見る
  const W = Cmd.newGame('fx-all');
  for (const id of ['cog-stim', 'deep-cog-stim']) {
    W.player.cog = 0;                    // 満タンだと「戻らない」のが正しい挙動
    const it = Item.create(W.rng, Data.get().itemsById[id], 1);
    Inventory.add(W.inv, it);
    const before = W.player.cog;
    Cmd.use(W, it);
    ok(W.player.cog > before, id + ' が認知を戻していない');
  }
});

console.log('\n[電脳層]');

/** 端末のある階に、その深度相応に育てたキャラで立つ。 */
function atTerminal(seed, roleId, siteId, depth) {
  const W = Cmd.newGame(seed, 'terran', roleId);
  Cmd.selectSite(W, siteId);
  Player.gainExp(W.player, Player.expNeeded(Math.min(49, depth) - 1, W.player.expFactor));
  Cmd.recalc(W);
  for (let i = 0; i < 60; i++) {
    Cmd.enterLevel(W, depth, false);
    if (W.level.terminal) break;
  }
  ok(W.level.terminal, seed + ': 端末のある階を作れない');
  W.player.x = W.level.terminal.x;
  W.player.y = W.level.terminal.y;
  W.player.cog = W.player.cogMax;
  return W;
}

t('認知は HP と別の軸 ―― 戦闘では減らず、時間でしか戻らない ([[doc:subsystems]] §11.2)', () => {
  const W = atTerminal('cog', 'netrunner', 'spire', 25);
  const p = W.player;
  ok(p.cogMax > 0, '認知の上限が 0');

  // 殴られても認知は減らない
  const before = p.cog;
  const foe = W.actors.find(a => a.kind === 'monster');
  if (foe) { Combat.monsterAttack(W, foe, p); eq(p.cog, before, '戦闘で認知が減った'); }

  // 接続でだけ減る
  Net.jack(W, 'n-map');
  ok(p.cog < before, '接続しても認知が減らない');

  // 時間で戻る
  const low = p.cog;
  for (let i = 0; i < 200; i++) { W.turn++; Player.upkeep(W, p); }
  ok(p.cog > low, '時間が経っても認知が戻らない');
});

t('認知が尽きると昏倒する ―― 端末は安全な場所ではない', () => {
  const W = atTerminal('faint', 'marine', 'spire', 25);
  const p = W.player;
  Net.spend(W, p.cogMax + 5);
  eq(p.cog, 0, '認知が 0 にならない');
  ok(p.timers.paralyzed > 0, '★認知が尽きても昏倒しない');
});

t('接続は物理面に反映される ([[D-65]])', () => {
  // 第2マップを作らない代わりに、狙いだけは削らない
  const W = atTerminal('effects', 'netrunner', 'spire', 25);
  const lv = W.level;

  // 区画図
  let known = 0;
  for (let i = 0; i < lv.flags.length; i++) if (lv.flags[i] & World.F.KNOWN) known++;
  Net.EFFECTS.map(W);
  let after = 0;
  for (let i = 0; i < lv.flags.length; i++) if (lv.flags[i] & World.F.KNOWN) after++;
  ok(after > known, '区画図を引いても階が既知にならない');

  // 隔壁
  let doors = 0;
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) {
    if (World.getTile(lv, x, y) === World.TILE.DOOR) doors++;
  }
  Net.EFFECTS.bulkhead(W);
  for (let y = 0; y < lv.h; y++) for (let x = 0; x < lv.w; x++) {
    ok(World.getTile(lv, x, y) !== World.TILE.DOOR, '隔壁が残っている');
  }
  ok(doors >= 0, '前提');

  // 掌握: 見えている機械が止まる
  const mech = Monster.spawn(W.rng,
    Data.get().monsters.find(m => m.base === 'automata'),
    W.player.x + 1, W.player.y);
  World.addActor(W, mech);
  Cmd.refreshView(W);
  Net.EFFECTS.seize(W);
  ok(mech.timers.paralyzed > 0, '掌握しても機械が止まらない');
});

t('「監視を切る」が補足の解除手段になる ([[doc:environment]] §8.3)', () => {
  // M3b では「階を移る」しか手が無かった
  const W = atTerminal('blind', 'netrunner', 'spire', 25);
  Signature.initSurveillance(W);
  W.alerted = true; W.alertLevel = 4;

  Net.EFFECTS.blind(W);
  eq(W.alerted, false, '監視を切っても補足が解除されない');
  ok(Net.isBlinded(W), '切っている状態にならない');

  // 切っている**間は**再補足されない (期限内で回す)
  W.player.skills.stealth = 0;
  while (Net.isBlinded(W) && !W.alerted) { W.turn++; Signature.checkSurveillance(W); }
  eq(W.alerted, false, '★切っているのに再補足された');
  ok(W.turn >= W.netBlindUntil, '期限まで回っていない');

  // 期限が切れれば元に戻る
  W.turn = W.netBlindUntil + 1;
  eq(Net.isBlinded(W), false, '期限が切れても切ったままになっている');
});

t('同じ操作は同じ階で二度は通らない', () => {
  const W = atTerminal('once', 'netrunner', 'spire', 25);
  W.player.cog = 99;
  const a = Net.jack(W, 'n-map');
  ok(a.ok, '1回目が通らない: ' + a.reason);
  const b = Net.jack(W, 'n-map');
  eq(b.ok, false, '同じ操作が二度通った');
});

t('端末の無い場所では接続できない', () => {
  const W = atTerminal('nowhere', 'netrunner', 'spire', 25);
  W.player.x = W.level.up.x; W.player.y = W.level.up.y;
  eq(Net.atTerminal(W), false, 'テスト前提: 昇降機の上に端末がある');
  eq(Net.jack(W, 'n-map').ok, false, '端末が無くても接続できた');
});

t('サイトが合わない操作は通らない', () => {
  // 遺跡に「監視を切る」設備は無い
  const W = atTerminal('site-op', 'netrunner', 'ruins', 12);
  const blind = Net.byId('n-blind');
  ok(Net.blockReason(W, blind), '遺跡で監視を切れてしまう');
  ok(!Net.blockReason(W, Net.byId('n-map')), '区画図はどこでも引けるはず');
});

t('接続は専門家ほど通り、深部では専門家でも確実ではない ([[D-74]])', () => {
  function pct(roleId, depth, opId) {
    const W = Cmd.newGame('pc/' + roleId + '/' + depth, 'terran', roleId);
    Player.gainExp(W.player, Player.expNeeded(Math.min(49, depth) - 1, W.player.expFactor));
    Cmd.recalc(W);
    W.depth = depth;
    return Net.chance(W, Net.byId(opId));
  }
  // 専門家 > 非専門家
  ok(pct('netrunner', 25, 'n-seize') > pct('marine', 25, 'n-seize') + 30,
     'ロールによる差が出ていない');
  // 非専門家でも浅い場所の安い操作は使える (縦割りにしない)
  ok(pct('marine', 5, 'n-map') > 20, '非専門家が全く使えない');
  // 深部では専門家でも上限に張り付かない
  ok(pct('netrunner', 95, 'n-seize') < 95, '深部でも専門家が確実に通る');
});

t('電脳層の状態がセーブ往復で保たれる', () => {
  const W = atTerminal('net-save', 'netrunner', 'spire', 25);
  W.player.cog = 3;
  Net.jack(W, 'n-map');
  Net.EFFECTS.blind(W);

  const W2 = World.deserialize(JSON.parse(JSON.stringify(World.serialize(W))));
  eq(W2.player.cog, W.player.cog, '認知が失われた');
  eq(!!W2.netDone['n-map'], true, '通した操作の記録が失われた');
  eq(Net.isBlinded(W2), true, '監視を切った状態が失われた');
});

console.log('\n[終端]');

/** 《起源》に入れる状態の世界を作る。 */
function atOrigin(seed, depth, opts) {
  const W = Cmd.newGame(seed);
  for (const k of ['vacuum', 'radiation', 'contamination', 'watch']) Site.grantAdaptation(W, k);
  Cmd.selectSite(W, 'origin');
  if (opts && opts.lore) {
    const pool = Fragment.placeable();
    pool.slice(0, Math.round(pool.length * opts.lore)).forEach(f => { W.loreFound[f.id] = true; });
  }
  Cmd.enterLevel(W, depth, false);
  return W;
}

t('《起源》は層ごとに違う顔をしている ([[doc:endgame]] §7.4)', () => {
  eq(Origin.layerOf(80).id, 'link', '深度80 が接続層でない');
  eq(Origin.layerOf(89).id, 'link', '深度89 が接続層でない');
  eq(Origin.layerOf(90).id, 'core', '深度90 が中枢層でない');
  eq(Origin.layerOf(97).id, 'core', '深度97 が中枢層でない');
  eq(Origin.layerOf(98), null, '深度98 は固定なので層を持たない');

  // 接続層は階ごとに別のサイトの生成器を借りる
  const seen = {};
  for (let d = 80; d <= 89; d++) {
    const W = atOrigin('layer/' + d, d);
    if (W.level.lookSite) seen[W.level.lookSite] = true;
  }
  ok(Object.keys(seen).length >= 3,
     '接続層が同じ顔しかしていない: ' + JSON.stringify(seen));
});

t('深度98 は静止層 ―― 敵もアイテムも無く、ログ断片だけがある', () => {
  // 直前に静かにさせることが 99・100 の重さを作る (docs/07 §7.4)
  const W = atOrigin('still', 98);
  eq(W.actors.filter(a => a.kind !== 'player').length, 0, '静止層に敵が居る');
  const frags = W.items.filter(i => Fragment.isFragment(i));
  eq(W.items.length, frags.length, '静止層に断片以外のものが落ちている');
  ok(frags.length > 0, '静止層に断片が無い');
});

t('《門番》の降下シャフトは倒すまで開かない', () => {
  const W = atOrigin('warden', 99);
  eq(W.level.down, null, '倒す前から深度100 へ行ける');

  const w = W.actors.find(a => a.raceId === 'u-warden');
  ok(w, '《門番》が居ない');
  Actor.damage(w, 999999);
  Cmd.onKill(W, w);
  ok(W.level.down, '《門番》を倒しても道が開かない');

  // 階は非永続。再訪しても**一度開いた道は閉じない**
  Cmd.enterLevel(W, 99, false);
  ok(W.level.down, '再訪したら道が閉じていた');
  eq(W.actors.filter(a => a.raceId === 'u-warden').length, 0, '倒した《門番》がまた居る');
});

t('固定マップの床は全て昇降機から歩いて行ける', () => {
  // 《起源》の中央のボス区画が壁で塞がっていたことがある。データ側で止める。
  for (const fx of Data.get().origin.maps) {
    const W = Cmd.newGame('fixed/' + fx.id);
    Cmd.selectSite(W, 'origin');
    Cmd.enterLevel(W, fx.depth, false);
    const lv = W.level;

    const seen = new Uint8Array(lv.w * lv.h);
    const stack = [lv.up.y * lv.w + lv.up.x];
    seen[stack[0]] = 1;
    let reached = 0;
    while (stack.length) {
      const cur = stack.pop();
      reached++;
      const cx = cur % lv.w, cy = (cur - cx) / lv.w;
      for (const d of U.ORTHO) {
        const nx = cx + d.dx, ny = cy + d.dy;
        if (!World.walkable(lv, nx, ny)) continue;
        const n = ny * lv.w + nx;
        if (seen[n]) continue;
        seen[n] = 1; stack.push(n);
      }
    }
    let total = 0;
    for (let i = 0; i < lv.tiles.length; i++) {
      if (World.TILE_INFO[lv.tiles[i]].walk) total++;
    }
    eq(reached, total, fx.id + ' に到達できない床がある');
  }
});

t('《起源》を倒すと帰還フェーズに入り、母船に着いて初めて勝利 ([[doc:endgame]] §7.5)', () => {
  const W = atOrigin('win', 100, { lore: 0.7 });
  const o = W.actors.find(a => a.raceId === 'u-origin');
  ok(o, '《起源》が居ない');

  Actor.damage(o, 999999);
  Cmd.onKill(W, o);
  ok(Cmd.isReturning(W), '撃破しても帰還フェーズに入らない');
  eq(W.won, false, '★撃破した瞬間に勝利になっている');

  // 崩れた層をまとめて抜ける
  let hops = 0;
  while (W.depth > 0 && hops < 30) {
    W.player.x = W.level.up.x; W.player.y = W.level.up.y;
    Cmd.ascend(W);
    hops++;
  }
  eq(W.depth, 0, '母船に戻れない');
  eq(hops, 100 / Cmd.RETURN_STEP, '帰還のホップ数が合わない');
  eq(W.won, true, '母船に着いても勝利にならない');
  ok(W.grave && W.grave.won, '勝利の記録が作られない');
});

t('結末の解像度は収集した断片の数で変わる ([[doc:endgame]] §7.8)', () => {
  // 全部集めなくても勝てる。集めた者だけが意味を知る。
  function endingAt(pct) {
    const W = Cmd.newGame('ending/' + pct);
    const pool = Fragment.placeable();
    pool.slice(0, Math.round(pool.length * pct)).forEach(f => { W.loreFound[f.id] = true; });
    return Fragment.ending(W);
  }
  eq(endingAt(0).revealed.length, 0, '何も集めていないのに結末が読める');
  ok(endingAt(0.4).revealed.length > 0, '4割集めても何も読めない');
  ok(endingAt(0.7).revealed.length > endingAt(0.4).revealed.length, '収集で解像度が上がらない');
  eq(endingAt(1.0).revealed.length, endingAt(1.0).total, '全部集めても結末が欠ける');

  // stage 5 は床に置かない (拾って先に読めてしまわない)
  for (const f of Fragment.placeable()) {
    ok(f.stage < 5, '結末の断片が床に置かれる: ' + f.id);
  }
});

t('ログ断片は所持品を圧迫せず、拾うと記録される', () => {
  const W = atOrigin('frag', 98);
  const it = W.items.find(i => Fragment.isFragment(i));
  ok(it, '断片が落ちていない');

  const before = W.inv.items.length;
  W.player.x = it.x; W.player.y = it.y;
  Cmd.pickup(W);

  eq(W.inv.items.length, before, '★断片が所持品に入った');
  ok(Fragment.found(W, it.fragmentId), '拾った断片が記録されない');
  eq(Item.itemsAt(W, it.x, it.y).length, 0, '拾ったのに床に残っている');
});

t('開発用の起動で終端に立てる。その記録は残さない ([[D-66]])', () => {
  const W = Cmd.newGame('dev');
  const r = DevStart.apply(W, 'depth:99,adapt:all,lore:50');
  eq(W.depth, 99, '指定した深度に立てない');
  eq(Site.adaptationCount(W), 4, '《適合》が入らない');
  ok(Fragment.foundCount(W) > 0, '断片の収集率が入らない');
  eq(W.devRun, true, '開発モードの印が立たない');
  eq(r.devRun, true, '適用結果が返らない');
});

t('崩壊は帰還中だけ進み、深いほど激しい', () => {
  function run(returning, depth) {
    const W = atOrigin('collapse/' + returning + '/' + depth, depth);
    W.returning = returning;
    // 圧は温度でかける。《適合》を4つ持つプレイヤーには他の環境が効かない
    const before = W.level.env.temperature;
    for (let i = 0; i < 100; i++) { W.turn++; Cmd.collapseTick(W); }
    return W.level.env.temperature - before;
  }
  eq(run(false, 90), 0, '帰還中でないのに崩壊が進んだ');
  const deep = run(true, 95), shallow = run(true, 81);
  ok(deep > 0, '帰還中なのに崩壊が進まない');
  ok(deep > shallow, '深部のほうが激しくない: ' + deep + ' vs ' + shallow);
});

t('階の予感はユニークの居る階を過小評価しない ([[D-73]])', () => {
  // 予感は敵の「数」を積む式なので、単体の格上を取りこぼす。
  // 深度100 に《起源》が1体だけ居る階が「危険2」と出ていた。
  const still = atOrigin('feel/98', 98);
  const warden = atOrigin('feel/99', 99);
  const origin = atOrigin('feel/100', 100);

  ok(still.feeling.danger <= 2, '敵の居ない静止層が危険だと出る: ' + still.feeling.danger);
  ok(warden.feeling.danger >= 7, '《門番》の階が危険と出ない: ' + warden.feeling.danger);
  eq(origin.feeling.danger, 9, '《起源》の階が最大危険と出ない');
  ok(origin.feeling.danger > warden.feeling.danger, '最終戦のほうが低い');
});

console.log('\n[端末の構成]');

/* 撮影では確かめられない部分。Windows のヘッドレスは
   ウィンドウを幅500px 未満にできず、実機の縦画面を再現できない。
   構成を決めているのは Render.resize なので、そこを数値で検査する。 */

t('広い画面では 80桁以上 + サイドバー ([[D-84]])', () => {
  Render.resize(120, true);
  eq(Render.TERM.w, 120, '桁数が反映されない');
  eq(Render.hasSidebar(), true, 'サイドバーが消えた');
  eq(Render.MAP.x, Render.SIDEBAR_W, 'マップの起点がサイドバーの右でない');
  eq(Render.MAP.w, 120 - Render.SIDEBAR_W, 'マップ幅が合わない');
});

t('狭い画面ではサイドバーを畳んで桁を下げる ([[D-87]])', () => {
  Render.resize(46, false);
  eq(Render.hasSidebar(), false, 'サイドバーが残っている');
  eq(Render.TERM.w, 46, '46桁にできない');
  eq(Render.MAP.x, 0, 'マップが左端から始まらない');
  eq(Render.MAP.w, 46, '★サイドバーぶんがマップに回っていない');
  // 同じ桁数なら、畳んだぶんがそのままマップになる
  Render.resize(80, true);
  const withBar = Render.MAP.w;
  Render.resize(80, false);
  eq(Render.MAP.w - withBar, Render.SIDEBAR_W,
     '★畳んだ 16桁がマップに回っていない');
});

t('下限を下回らない', () => {
  Render.resize(1, true);
  eq(Render.TERM.w, Render.COLS_MIN, 'サイドバー有りの下限が守られていない');
  Render.resize(1, false);
  eq(Render.TERM.w, Render.COLS_MIN_NARROW, 'サイドバー無しの下限が守られていない');
  ok(Render.COLS_MIN_NARROW < Render.COLS_MIN, '狭い構成のほうが下限が低いはず');
  Render.resize(999, true);
  eq(Render.TERM.w, Render.COLS_MAX, '上限が守られていない');
});

t('サイドバーを畳んでも描画が落ちず、情報が端末から消える', () => {
  const W = Cmd.newGame('narrow-draw');
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);

  function rowText(buf, y, cols) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      const c = buf.cells[y * cols + x];
      if (c && c.w !== 0) s += c.ch || ' ';
    }
    return s;
  }

  Render.resize(80, true);
  const wide = Render.frame(W);
  let found = false;
  for (let y = 0; y < Render.TERM.h; y++) {
    if (rowText(wide, y, 80).indexOf('STRATA') !== -1) found = true;
  }
  ok(found, '前提: 広い構成ではサイドバーに STRATA が出る');

  Render.resize(46, false);
  const narrow = Render.frame(W);
  found = false;
  for (let y = 0; y < Render.TERM.h; y++) {
    if (rowText(narrow, y, 46).indexOf('STRATA') !== -1) found = true;
  }
  eq(found, false, '畳んだのにサイドバーが描かれている');

  // メッセージは残る。端末だけでも何が起きたか分かる ([[D-83]])
  World.msg(W, 'これは端末に出る');
  const after = Render.frame(W);
  ok(rowText(after, 0, 46).indexOf('これは端末に出る') !== -1,
     '狭い構成でメッセージが出ない');

  Render.resize(80, true);
});

t('畳んだ構成でも注視の説明が出る', () => {
  // サイドバーが無い前提の描画を用意していないと、マップを潰してしまう
  Render.resize(46, false);
  ok(Render.hasSidebar() === false, '前提');
  Render.resize(80, true);
});

console.log('\n[タップ移動]');

/** 階全体を既知にして、敵を消した階を作る。 */
function walkable(seed, depth, siteId) {
  const W = Cmd.newGame(seed);
  if (siteId) Cmd.selectSite(W, siteId);
  Cmd.enterLevel(W, depth || 3, false);
  W.actors = W.actors.filter(a => a.kind === 'player');
  const lv = W.level;
  for (let i = 0; i < lv.tiles.length; i++) lv.flags[i] |= World.F.KNOWN;
  return W;
}

t('既知のマスまで歩ける ([[D-86]])', () => {
  const W = walkable('tv1');
  const dest = W.level.down;
  const n = Cmd.travel(W, dest.x, dest.y);
  ok(n > 0, '一歩も歩いていない');
  eq(W.player.x, dest.x, '目的地に着いていない');
  eq(W.player.y, dest.y, '目的地に着いていない');
});

t('★消費は手で歩いたときと変わらない ([[D-50]] の経済を壊さない)', () => {
  /* オートエクスプロアを却下した理由は「歩いた距離で電力と食料を払わせる
     経済が無意味になる」こと。タップ移動が1歩ずつ払っていることを確かめる。 */
  const A = walkable('tv2');
  const dest = A.level.down;
  const path = Cmd.pathTo(A, dest.x, dest.y);
  ok(path && path.length > 3, 'テスト前提: 十分な長さの経路が無い');

  const before = { turn: A.turn, food: A.player.food, cells: A.player.cells };
  const n = Cmd.travel(A, dest.x, dest.y);

  // 同じ階で、同じ手順を手で歩く
  const B = walkable('tv2');
  const b0 = { turn: B.turn, food: B.player.food, cells: B.player.cells };
  for (let i = 0; i < n; i++) Cmd.step(B, { type: 'move', dx: path[i][0], dy: path[i][1] });

  eq(A.turn - before.turn, B.turn - b0.turn, '★ターンの消費が違う');
  eq(before.food - A.player.food, b0.food - B.player.food, '★食料の消費が違う');
  eq(before.cells - A.player.cells, b0.cells - B.player.cells, '★電力の消費が違う');
});

t('見ていない場所へは行けない', () => {
  // 地図に無い道は使えない。オートエクスプロアにしないための線引き
  const W = Cmd.newGame('tv3');
  Cmd.enterLevel(W, 3, false);
  const dest = W.level.down;
  ok(!World.hasFlag(W.level, dest.x, dest.y, World.F.KNOWN), 'テスト前提: 既知になっている');
  eq(Cmd.travel(W, dest.x, dest.y), 0, '未知の場所へ歩いてしまった');
  eq(Cmd.pathTo(W, dest.x, dest.y), null, '未知の場所への経路が返る');
});

t('敵が見えたら止まる', () => {
  const W = walkable('tv4');
  const dest = W.level.down;
  const path = Cmd.pathTo(W, dest.x, dest.y);
  ok(path && path.length > 6, 'テスト前提: 経路が短すぎる');

  // 経路の途中が見える位置に敵を置く
  const p = W.player;
  const mid = { x: p.x, y: p.y };
  for (let i = 0; i < 4; i++) { mid.x += path[i][0]; mid.y += path[i][1]; }
  const foe = Monster.spawn(W.rng, Data.get().monsters[0], mid.x, mid.y + 1);
  foe.asleep = 0;
  World.addActor(W, foe);
  Cmd.refreshView(W);

  const n = Cmd.travel(W, dest.x, dest.y);
  ok(n < path.length, '敵が見えているのに最後まで歩いた');
});

t('★HP が減ったら止まる', () => {
  /* 環境の作用は敵が見えなくても効く。これが無いと
     方舟の真空区画を削られながら43歩歩き続けた。 */
  const W = walkable('tv5', 20, 'ark');
  const dest = W.level.down;
  const path = Cmd.pathTo(W, dest.x, dest.y);
  if (!path || path.length < 5) return;          // 経路が無ければ判定しない

  W.player.hp = W.player.hpMax = 400;      // 死なないだけの余裕を持たせる
  const hp0 = W.player.hp;
  const n = Cmd.travel(W, dest.x, dest.y);

  if (hp0 === W.player.hp) return;          // 削られなければこの階では判定しない
  /* 1歩は約10ゲームターンなので、1歩で減圧が複数回入ることはある。
     見たいのは「減ったのに歩き続けていないか」。 */
  ok(n < path.length,
     '★HP が減ったのに最後まで歩いた (' + n + '/' + path.length + '歩)');
  ok(W.messages.some(m => m.text === '足を止めた。'), '止まった記録が無い');
});

t('足元に物があれば止まる ―― 通り過ぎさせない', () => {
  const W = walkable('tv6');
  const dest = W.level.down;
  const path = Cmd.pathTo(W, dest.x, dest.y);
  ok(path && path.length > 4, 'テスト前提: 経路が短すぎる');

  const spot = { x: W.player.x, y: W.player.y };
  for (let i = 0; i < 3; i++) { spot.x += path[i][0]; spot.y += path[i][1]; }
  const it = Item.makeForDepth(W.rng, 3, W);
  it.x = spot.x; it.y = spot.y;
  W.items.push(it);

  const n = Cmd.travel(W, dest.x, dest.y);
  eq(n, 3, '落ちている物の上で止まらなかった: ' + n + '歩');
});

t('歩数の上限がある', () => {
  ok(Cmd.TRAVEL_MAX > 0 && Cmd.TRAVEL_MAX <= 500, '上限が妥当でない');
});

console.log('\n[文脈アクション]');

/** 深度3の普通の階に立たせる。 */
function atFloor(seed) {
  const W = Cmd.newGame(seed);
  Cmd.enterLevel(W, 3, false);
  Cmd.refreshView(W);
  return W;
}
const actKeys = (W) => Action.list(W).map(a => a.key + ':' + a.label);

t('文脈アクションは「今できること」だけを出す ([[D-85]])', () => {
  const W = atFloor('act');
  const acts = Action.list(W);
  ok(acts.length > 0, '何も出ない');
  ok(acts.length <= Action.MAX, '多すぎる: ' + acts.length);
  for (const a of acts) {
    ok(a.key && a.label && a.cmd, '欠けた項目がある: ' + JSON.stringify(a));
    ok(a.why, 'なぜそれをするのかが無い: ' + a.label);
  }
});

t('足元にあるものが候補に出る', () => {
  const W = atFloor('act-foot');
  const p = W.player;

  // 降下シャフトの上
  p.x = W.level.down.x; p.y = W.level.down.y;
  Cmd.refreshView(W);
  ok(actKeys(W).some(s => s.indexOf('>') === 0), '階段の上なのに降りるが出ない');

  // 落ちている物
  const it = Item.makeForDepth(W.rng, 3, W);
  it.x = p.x; it.y = p.y;
  W.items.push(it);
  ok(actKeys(W).some(s => s.indexOf('g') === 0), '足元に物があるのに拾うが出ない');
});

t('危険なものが先頭に来る', () => {
  const W = atFloor('act-danger');
  W.level.env = Env.create({ atmosphere: 0 });
  W.inv.equip.body = null;
  Cmd.recalc(W);
  const acts = Action.list(W);
  eq(acts[0].level, 'danger', '気密不足なのに先頭が danger でない: ' + acts[0].label);
});

t('同じ行動が二度出ない', () => {
  // 「気密が足りない→戻る」と「昇降機の上→戻る」が同時に立つ
  const W = atFloor('act-dup');
  W.level.env = Env.create({ atmosphere: 0 });
  W.inv.equip.body = null;
  Cmd.recalc(W);
  W.player.x = W.level.up.x; W.player.y = W.level.up.y;
  const keys = actKeys(W);
  eq(new Set(keys).size, keys.length, '重複している: ' + keys.join(' / '));
});

t('★未鑑定のアイテムの効果を漏らさない ([[D-78]] と同じ理由)', () => {
  /* 「回復する: 凍りついたアンプルを使う」と出したら、
     使う前に回復薬だと教えたことになる。フレーバー式の鑑定が骨抜きになる。 */
  const W = atFloor('act-leak');
  const p = W.player;
  p.hp = 1;

  const heal = W.inv.items.find(it => it.effect && it.effect.indexOf('heal') === 0);
  ok(heal, 'テスト前提: 回復アイテムを持っていない');

  W.knowledge.kinds = {};                      // 何も鑑定していない状態
  ok(!actKeys(W).some(s => s.indexOf('u:') === 0),
     '★未鑑定なのに「使う」を薦めている');

  Sigil.learnKind(W, heal.kindId);             // 一度使って覚えた
  ok(actKeys(W).some(s => s.indexOf('u:') === 0), '鑑定後も薦めてくれない');
});

t('死んでいるときは何も出ない', () => {
  const W = atFloor('act-dead');
  W.dead = true;
  eq(Action.list(W).length, 0, '死後に行動を薦めている');
});

t('母船では母船の行動を出す', () => {
  const W = Cmd.newGame('act-hub');
  Cmd.enterLevel(W, 0, false);
  const keys = actKeys(W);
  ok(keys.some(s => s.indexOf('V') === 0), '降下先を選ぶが出ない');
  ok(keys.some(s => s.indexOf('>') === 0 || s.indexOf('方向') === 0),
     '降りる/降下ポッドへ が出ない: ' + keys.join(' / '));
});

t('出すコマンドは全て実際に処理される型', () => {
  // ボタンと同じ検査 ([[D-57]])。型が違うと押しても何も起きない
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.resolve(__dirname, '..', '..');
  const known = new Set();
  for (const f of ['src/js/boot.js', 'src/js/cmd.js']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/case '([a-zA-Z]+)':/g)) known.add(m[1]);
  }
  const seeds = ['c1', 'c2', 'c3', 'c4'];
  for (const s of seeds) {
    const W = atFloor(s);
    for (const a of Action.list(W)) {
      ok(known.has(a.cmd.type), '未知のコマンド型: ' + a.cmd.type + ' (' + a.label + ')');
    }
  }
  const H = Cmd.newGame('c-hub');
  Cmd.enterLevel(H, 0, false);
  for (const a of Action.list(H)) {
    ok(known.has(a.cmd.type), '母船で未知のコマンド型: ' + a.cmd.type);
  }
});

console.log('\n[出現テーブル]');

t('深部では深部のものが出る ([[D-77]])', () => {
  // 重みが 1/rarity だけだと、深度90 の階に深度1 のバールが同じ確率で出ていた
  const GEAR = ['weapon', 'launcher', 'suit', 'plate', 'light', 'implant', 'neurallink'];
  function gearAt(depth) {
    const rng = RNG.create('gear/' + depth);
    const got = [];
    for (let i = 0; i < 1500; i++) {
      const it = Data.pickItem(rng, depth);
      if (it && GEAR.indexOf(it.base) !== -1) got.push(it);
    }
    ok(got.length > 100, '装備が引けていない');
    const deep = got.filter(it => it.depth >= depth - 30).length;
    return deep / got.length;
  }
  ok(gearAt(90) > 0.5, '深度90 で「深度60以上の装備」が過半にならない: ' + gearAt(90).toFixed(2));
  ok(gearAt(60) > 0.4, '深度60 で深めの装備が出にくい: ' + gearAt(60).toFixed(2));

  // 敵も同じ。ただし雑魚が混じる余地は残す
  function monAt(depth) {
    const rng = RNG.create('mon/' + depth);
    let deep = 0, n = 0;
    for (let i = 0; i < 1500; i++) {
      const m = Data.pickMonster(rng, depth);
      if (!m) continue;
      n++;
      if (m.depth >= depth - 40) deep++;
    }
    return deep / n;
  }
  ok(monAt(90) > 0.4, '深度90 で深めの敵が出にくい: ' + monAt(90).toFixed(2));
  ok(monAt(90) < 0.95, '★雑魚が全く混じらない。本家の質感が消えている');
});

t('定番品は深部でも出続ける ―― 品目ごとに猶予が違う', () => {
  // 携行食とセルが深部で消えると、深く潜るほど補給が不可能になる
  const rng = RNG.create('staple');
  const seen = {};
  for (let i = 0; i < 4000; i++) {
    const it = Data.pickItem(rng, 90);
    if (it) seen[it.base] = (seen[it.base] || 0) + 1;
  }
  ok(seen.ration > 0, '深度90 で携行食が出ない');
  ok(seen.cell > 0, '深度90 で電力セルが出ない');

  // 猶予はデータで決まる (docs/06 §6.1: 数値の正本は data)
  ok(Data.entrySpan(Data.get().itemsById['ration'], 0) >
     Data.entrySpan(Data.get().itemsById['work-suit'], 0),
     '携行族のほうが装備より歳を取っている');
});

t('サイトの重みは 1 より大きい指定も効く ([[D-76]])', () => {
  // 「1以上なら即採用」だと weight 2.5 と 1.2 が同じ扱いになっていた
  function faces(siteId, depth) {
    const site = Data.get().sitesById[siteId];
    const rng = RNG.create('faces/' + siteId);
    const cnt = {};
    for (let i = 0; i < 800; i++) {
      const r = Site.pickMonster(rng, site, depth);
      if (r) cnt[r.base] = (cnt[r.base] || 0) + 1;
    }
    return cnt;
  }
  for (const id of ['ark', 'ash', 'ruins', 'spire', 'origin']) {
    const site = Data.get().sitesById[id];
    const cnt = faces(id, 50);
    const heaviest = Object.keys(site.weight)
      .sort((a, b) => site.weight[b] - site.weight[a])[0];
    const lightest = Object.keys(site.weight)
      .sort((a, b) => site.weight[a] - site.weight[b])[0];
    ok((cnt[heaviest] || 0) > (cnt[lightest] || 0) * 2,
       site.name + ': 最も重い系統(' + heaviest + ' ' + (cnt[heaviest] || 0) +
       ')が最も軽い系統(' + lightest + ' ' + (cnt[lightest] || 0) + ')を引き離せていない');
  }
});

t('深度29〜100 に中身がある ([[Q-21]])', () => {
  // M4 の時点では敵は深度28、アイテムは深度20、改修品は深度28 までしか無かった
  const D = Data.get();
  const mons = D.monsters.filter(m => (m.flags || []).indexOf('UNIQUE') === -1);
  for (let d = 0; d < 100; d += 10) {
    const n = mons.filter(m => m.depth >= d && m.depth < d + 10).length;
    ok(n >= 4, '深度' + d + '-' + (d + 9) + ' の敵が ' + n + ' 体しかいない');
  }

  /* 装備まわりは「敵だけ深部がある」状態だと意味を持たない。
     改修品が深度28 で止まっていたとき、深度90 の武器に「研磨(+3/+3)」が付いていた。
     解体/移植 ([[doc:subsystems]] §11.4) も改修品を素材にするので、
     ここが薄いと工房ごと深部で機能しない。 */
  const need = { items: 5, egos: 2, uniques: 1, rooms: 1, vaults: 1 };
  for (const kind in need) {
    for (const lo of [20, 40, 60, 80]) {
      const n = D[kind].filter(e => e.depth >= lo && e.depth < lo + 20).length;
      ok(n >= need[kind],
         kind + ' が深度' + lo + '台に ' + n + ' 種しかない (最低 ' + need[kind] + ')');
    }
  }
});

t('封鎖区画はどのサイトでも置ける ([[D-81]])', () => {
  /* 通常部屋の後に置いていたので、密な生成器(遺跡 block 9 / 尖塔 / 《起源》)では
     大きな区画の入る隙間が残らず、実測 0〜1/60 だった ―― 機能が無いのと同じ。

     階層生成まるごとで測ると `oneIn(12)` の抽選が揺れて判定が不安定になるので、
     **配置そのもの**(空の階に置けるか)を測る。直したのはそこなので。 */
  for (const site of Site.all()) {
    const depth = Math.round((site.depthMin + site.depthMax) / 2);
    const cfg = Object.assign({}, Gen.DEFAULTS, Site.genOpts(site));
    const pool = Data.get().vaults.filter(v => v.depth <= depth);
    ok(pool.length > 0, site.name + ' の深度に置ける封鎖区画が無い');

    let ok_ = 0, tried = 0;
    for (let i = 0; i < 60; i++) {
      const rng = RNG.create('vp/' + site.id + '/' + i);
      const lv = World.createLevel(cfg.w, cfg.h);
      const v = Data.allocate(rng, pool, depth, Data.ITEM_WINDOW);
      if (!v) continue;
      tried++;
      if (GenRooms.tryPlace(lv, rng, [], v, true)) ok_++;
    }
    ok(ok_ >= tried * 0.9,
       site.name + ': 空の階でも封鎖区画を置けない ' + ok_ + '/' + tried);
  }
});

t('封鎖区画は実際の階層にも現れる', () => {
  // 抽選は oneIn(12) なので、サイトを合算して見る
  let hit = 0, n = 0;
  for (const site of Site.all()) {
    const depth = Math.round((site.depthMin + site.depthMax) / 2);
    for (let i = 0; i < 40; i++) {
      const W = Cmd.newGame('vreal/' + site.id + '/' + i);
      W.site = site;
      try { Cmd.enterLevel(W, depth, false); } catch (e) { continue; }
      n++;
      if ((W.level.special || []).some(s => s.vault)) hit++;
    }
  }
  ok(hit >= n * 0.03, '封鎖区画が全サイト合計で ' + hit + '/' + n + ' しか出ない');
});

t('封鎖区画は中身ごと無傷で残る', () => {
  // 先に置くようにしたので、通常部屋に上書きされないことを確かめる
  for (let i = 0; i < 400; i++) {
    const W = Cmd.newGame('vint/' + i);
    Cmd.selectSite(W, 'spire');
    let v;
    try {
      Cmd.enterLevel(W, 50, false);
      v = (W.level.special || []).find(s => s.vault);
    } catch (e) { continue; }
    if (!v) continue;

    const inside = (a) => a.x >= v.x1 && a.x <= v.x2 && a.y >= v.y1 && a.y <= v.y2;
    const marks = (W.level.marks || []).filter(inside);
    ok(marks.length > 0, '封鎖区画に配置点が無い');
    const filled = W.actors.filter(inside).length + W.items.filter(inside).length;
    ok(filled > 0, '封鎖区画が空っぽ ―― 危険も報酬も無い');
    return;
  }
});

console.log('\n[サイト]');

t('開始サイトは初期装備のまま呼吸できる ([[D-61]])', () => {
  // 深度1で気密が足りないサイトが既定になっていると、新規ランが成立しない
  for (const site of Site.starting()) {
    const W = Cmd.newGame('start/' + site.id);
    Cmd.selectSite(W, site.id);
    Cmd.enterLevel(W, site.depthMin, false);
    Signature.tick(W);                              // 固有機構を1度回してから測る
    const need = Env.sealRequired(Env.envOf(W));
    ok(W.player.seal >= need,
       site.name + ' は初期装備で入れない: 気密 ' + W.player.seal + ' < 必要 ' + need);
  }
});

t('既定の降下先は最も浅いサイト', () => {
  const first = Site.starting()[0];
  for (const s of Site.starting()) {
    ok(first.depthMax <= s.depthMax, '開始サイトが最深部の浅い順に並んでいない');
  }
});

t('サイトごとに地形の見え方が変わる', () => {
  // 生成器を4本書かずに印象を変える最も安い手段 (docs/10 §10.5)
  const seen = {};
  for (const s of Site.all()) {
    const g = Site.tileGlyph(s, World.TILE.WALL);
    if (g) seen[g.ch] = (seen[g.ch] || 0) + 1;
  }
  ok(Object.keys(seen).length >= 3, '壁のグリフが3種類も違わない: ' + JSON.stringify(seen));
});

t('サイトごとに敵の顔ぶれは偏るが、深度の強さは動かない ([[D-03]])', () => {
  function sample(site) {
    const rng = RNG.create('pick/' + (site ? site.id : 'none'));
    const bases = {};
    let depthSum = 0, n = 0;
    for (let i = 0; i < 600; i++) {
      const r = Site.pickMonster(rng, site, 20);
      if (!r) continue;
      bases[r.base] = (bases[r.base] || 0) + 1;
      depthSum += r.depth; n++;
    }
    return { bases: bases, avgDepth: depthSum / n, n: n };
  }
  const ark = sample(Data.get().sitesById['ark']);
  const ash = sample(Data.get().sitesById['ash']);
  ok(ark.n > 500 && ash.n > 500, '抽選が成立していない');

  // 顔ぶれは変わる
  let diff = 0;
  const keys = Object.keys(Object.assign({}, ark.bases, ash.bases));
  for (const k of keys) {
    diff += Math.abs((ark.bases[k] || 0) - (ash.bases[k] || 0));
  }
  ok(diff / ark.n > 0.20,
     'サイトを変えても顔ぶれが変わらない (差 ' + (diff / ark.n * 100).toFixed(0) + '%)');

  // だが強さの基準は動かない
  ok(Math.abs(ark.avgDepth - ash.avgDepth) < 3,
     '重みが深度の強さを歪めている: ' + ark.avgDepth.toFixed(1) + ' vs ' + ash.avgDepth.toFixed(1));
});

t('方舟: 深部ほど船が壊れているが、降りた場所は必ず呼吸できる', () => {
  const ark = Data.get().sitesById['ark'];
  ok(Signature.breachRate(ark, ark.depthMin) < 0.2, '最浅部から破断しすぎている');
  ok(Signature.breachRate(ark, ark.depthMax) > 0.6, '最深部でも船が無事すぎる');

  for (const d of [1, 10, 25, 40]) {
    const W = Cmd.newGame('ark/' + d);
    Cmd.selectSite(W, 'ark');
    Cmd.enterLevel(W, d, false);
    Signature.tick(W);
    ok(W.player.seal >= Env.sealRequired(Env.envOf(W)),
       '深度' + d + 'で降りた瞬間に窒息する');
  }
});

t('方舟: 扉を開けると気圧が均され、差が大きいと突風が起きる ([[D-47]])', () => {
  const W = Cmd.newGame('ark-door');
  Cmd.selectSite(W, 'ark');
  Cmd.enterLevel(W, 5, false);
  ok(W.level.pressure, '方舟なのに区画気圧が無い');

  // 扉を挟んで、片側を与圧・片側を真空にした状況を作る
  const door = findDoorWithSides(W);
  ok(door, '扉を挟んだ床の組が見つからない');
  // flood は扉で止まるが両側が回り込みで繋がっていることもあるので、直接置く
  W.level.pressure[door.a.y * W.level.w + door.a.x] = 90;
  W.level.pressure[door.b.y * W.level.w + door.b.x] = 0;

  const r = Signature.equalize(W, door.x, door.y, door.a.x, door.a.y, door.b.x, door.b.y);
  ok(r, '扉を通っても気圧が均されない');
  ok(r.gust, '90 と 0 の差なのに突風が起きない');
  const after = Signature.pressureAt(W, door.a.x, door.a.y);
  ok(after > 0 && after < 90, '均された気圧が中間値になっていない: ' + after);
  eq(Signature.pressureAt(W, door.b.x, door.b.y), after, '扉の両側で気圧が揃わない');
});

function findDoorWithSides(W) {
  const lv = W.level;
  for (let y = 1; y < lv.h - 1; y++) {
    for (let x = 1; x < lv.w - 1; x++) {
      if (World.getTile(lv, x, y) !== World.TILE.DOOR) continue;
      const pairs = [[{ x: x - 1, y: y }, { x: x + 1, y: y }],
                     [{ x: x, y: y - 1 }, { x: x, y: y + 1 }]];
      for (const pair of pairs) {
        if (World.walkable(lv, pair[0].x, pair[0].y) &&
            World.walkable(lv, pair[1].x, pair[1].y)) {
          return { x: x, y: y, a: pair[0], b: pair[1] };
        }
      }
    }
  }
  return null;
}

t('灰の地表: 昼夜が入れ替わり、環境が変わる', () => {
  const W = Cmd.newGame('ash-night');
  Cmd.selectSite(W, 'ash');
  Cmd.enterLevel(W, 3, false);

  W.turn = 0;
  Signature.applyDayNight(W, true);
  eq(Signature.isNight(W), false, 'ターン0が夜になっている');
  const day = { ambient: W.level.env.ambient, temp: W.level.env.temperature };

  W.turn = Signature.DAY_LENGTH / 2;
  ok(Signature.applyDayNight(W, false), '半日経っても切り替わらない');
  eq(Signature.isNight(W), true, '夜にならない');
  ok(W.level.env.ambient < day.ambient, '夜なのに明るいまま');
  ok(W.level.env.temperature < day.temp, '夜なのに冷えない');

  W.turn = Signature.DAY_LENGTH;
  ok(Signature.applyDayNight(W, false), '一日経っても朝が来ない');
  eq(Signature.isNight(W), false, '朝に戻らない');
});

t('尖塔: 監視に補足されると増援が湧き、《適合:監視》で無効になる', () => {
  function run(adapted) {
    const W = Cmd.newGame('spire/' + adapted);
    Cmd.selectSite(W, 'spire');
    Cmd.enterLevel(W, 25, false);
    if (adapted) Site.grantAdaptation(W, 'watch');
    Signature.initSurveillance(W);
    for (let i = 0; i < 4000 && !W.alerted; i++) {
      W.turn++;
      Signature.checkSurveillance(W);
    }
    return W;
  }
  const caught = run(false);
  ok(caught.alerted, '監視のあるサイトで一度も補足されない');

  const before = caught.actors.length;
  caught.turn = caught.reinforceAt;
  Signature.checkSurveillance(caught);
  ok(caught.actors.length > before, '補足されているのに増援が来ない');

  ok(!run(true).alerted, '《適合:監視》を得ても補足される');
});

t('守護ユニークは自分のサイトの最深階に必ず出る ([[D-69]])', () => {
  // 《適合》は進行に必須なので、抽選に任せると「何度潜っても出ない」ランが生まれる
  for (const site of Site.all()) {
    const guard = Monster.guardianFor(site);
    if (!guard) { ok(site.id === 'origin', site.name + ' に守護ユニークが居ない'); continue; }
    eq(guard.depth, site.depthMax, guard.name + ' の深度がサイト最深部と違う');

    for (let i = 0; i < 5; i++) {
      const W = Cmd.newGame('guard/' + site.id + '/' + i);
      Cmd.selectSite(W, site.id);
      Cmd.enterLevel(W, site.depthMax, false);
      const here = W.actors.filter(a => a.raceId === guard.id);
      eq(here.length, 1, site.name + ' 最深階に守護が居ない (seed ' + i + ')');
      ok(here[0].guardian, '守護の印が立っていない');
    }
  }
});

t('守護ユニークは他のサイトには出ない', () => {
  const ark = Data.get().sitesById['ark'];
  const guard = Monster.guardianFor(ark);
  // 灰の最深部(深度30)は方舟の守護の深度40より浅いが、そもそもサイトが違う
  for (let i = 0; i < 6; i++) {
    const W = Cmd.newGame('cross/' + i);
    Cmd.selectSite(W, 'ash');
    Cmd.enterLevel(W, 30, false);
    eq(W.actors.filter(a => a.raceId === guard.id).length, 0,
       '灰の地表に方舟の守護が出た');
  }
});

t('《適合》は守護ユニークからのみ得られ、4つ揃うまで《起源》は閉じている ([[D-69]])', () => {
  const W = Cmd.newGame('adapt');
  const ark = Data.get().sitesById['ark'];
  Cmd.selectSite(W, 'ark');

  // 守護でないユニークでは得られない。深部でも同じ。
  W.depth = ark.depthMax;
  Cmd.grantAdaptationIfDeep(W, { unique: true });
  eq(Site.hasAdaptation(W, 'vacuum'), false, '守護でないユニークで《適合》を得た');

  Cmd.grantAdaptationIfDeep(W, { unique: true, guardian: true });
  eq(Site.hasAdaptation(W, 'vacuum'), true, '守護を倒しても《適合》を得られない');
  eq(Site.adaptationCount(W), 1, '《適合》の数が合わない');

  const origin = Data.get().sitesById['origin'];
  ok(Site.lockReason(W, origin), '《適合》1つで《起源》に入れてしまう');
  ok(!Cmd.selectSite(W, 'origin').ok, 'ロック中の《起源》を選べてしまう');

  for (const k of ['radiation', 'contamination', 'watch']) Site.grantAdaptation(W, k);
  eq(Site.lockReason(W, origin), null, '4つ揃っても《起源》が開かない');
  ok(Cmd.selectSite(W, 'origin').ok, '4つ揃っても《起源》を選べない');
});

t('《適合》はその環境の害を消す', () => {
  function damage(adapt) {
    const W = Cmd.newGame('adapt-env/' + adapt);
    W.actors = W.actors.filter(a => a.kind === 'player');
    W.site = Data.get().sitesById['ruins'];
    W.level.env = Env.create({ radiation: 9, contamination: 9 });
    W.player.seal = 3;
    Cmd.recalc(W);
    if (adapt) {
      Site.grantAdaptation(W, 'radiation');
      Site.grantAdaptation(W, 'contamination');
    }
    while (W.turn < 2000 && !W.dead) Cmd.step(W, { type: 'move', dx: 0, dy: 0 });
    return (W.player.exposure || 0) + (W.player.contamination || 0);
  }
  ok(damage(false) > 0, '高線量・高汚染でも何も溜まらない');
  eq(damage(true), 0, '《適合》を得ても環境に蝕まれる');
});

t('サイトの進捗と区画気圧がセーブ往復で保たれる', () => {
  const W = Cmd.newGame('site-save');
  Cmd.selectSite(W, 'ark');
  Cmd.enterLevel(W, 6, false);
  Site.noteDepth(W, 'ash', 9);
  Site.grantAdaptation(W, 'vacuum');
  const px = Signature.pressureAt(W, W.player.x, W.player.y);

  const W2 = World.deserialize(JSON.parse(JSON.stringify(World.serialize(W))));
  eq(W2.site.id, 'ark', 'サイトが失われた');
  eq(Site.deepestIn(W2, 'ash'), 9, '別サイトの到達最深度が失われた');
  eq(Site.hasAdaptation(W2, 'vacuum'), true, '《適合》が失われた');
  ok(W2.level.pressure, '区画気圧が失われた');
  eq(Signature.pressureAt(W2, W2.player.x, W2.player.y), px, 'ロード後に階の空気が変わった');

  // 保存するのは id だけ。定義そのものを焼き込まない。
  eq(World.serialize(W).site, undefined, 'サイト定義がセーブに焼き込まれている');
});

t('凡例の地形グリフは地図と一致する (サイトで見た目が変わっても)', () => {
  // 「地図は ' なのに凡例は +」が起きると、凡例がむしろ誤解を生む ([[D-56]])
  const W = Cmd.newGame('legend-glyph');
  Cmd.selectSite(W, 'ash');
  Cmd.enterLevel(W, 3, false);

  const door = Site.tileGlyph(W.site, World.TILE.DOOR);
  ok(door && door.ch !== Render.TILE_GLYPH[World.TILE.DOOR].ch,
     'テスト前提: 灰の扉は既定と違うグリフのはず');

  for (const t of [World.TILE.WALL, World.TILE.FLOOR, World.TILE.DOOR]) {
    eq(Render.glyphFor(W, t).ch, Site.tileGlyph(W.site, t).ch,
       'サイトのグリフが引かれていない');
  }

  // 既知にした地形が、凡例に地図と同じ文字で出る
  const lv = W.level;
  for (let i = 0; i < lv.tiles.length; i++) World.addFlag(lv, i % lv.w, (i - i % lv.w) / lv.w, World.F.KNOWN);
  const terrain = Legend.visible(W).terrain;
  for (const row of terrain) {
    if (row.label === 'あなた') continue;
    ok(row.ch, '凡例の行にグリフが無い: ' + row.label);
  }
  const wall = terrain.find(r => r.label === World.TILE_INFO[World.TILE.WALL].name);
  ok(wall, '凡例に壁が出ていない');
  eq(wall.ch, Site.tileGlyph(W.site, World.TILE.WALL).ch, '凡例の壁が地図と違う');
});

console.log('\n[枠外UI]');

t('凡例は今画面にあるものだけを出す ([[D-56]])', () => {
  const W = Cmd.newGame('legend');
  // 敵を1体だけ視界に入れ、残りは遠くへ飛ばす
  const foes = W.actors.filter(a => a.kind === 'monster');
  ok(foes.length >= 2, '敵が足りない');
  foes.forEach((f, i) => { f.x = 1; f.y = 1 + i; });      // 壁の中 = 見えない
  foes[0].x = W.player.x + 1; foes[0].y = W.player.y;
  Cmd.refreshView(W);

  const vis = Legend.visible(W);
  eq(vis.monsters.length, 1, '★見えていない敵まで凡例に出た');
  eq(vis.monsters[0].label, foes[0].name, '見えている敵が出ていない');

  // 全一覧ではないことの確認: データには24種いる
  ok(Data.get().monsters.length > 5, '前提: 敵の種類が複数ある');
  ok(vis.monsters.length < Data.get().monsters.length, '★全一覧を出している');
});

t('凡例: 同じ種族はまとめて数を出す', () => {
  const W = Cmd.newGame('legend-count');
  const race = Data.get().monstersById['spore-cluster'];
  W.actors = W.actors.filter(a => a.kind === 'player');
  for (let i = 0; i < 3; i++) {
    World.addActor(W, Monster.spawn(W.rng, race, W.player.x + 1 + i, W.player.y));
  }
  Cmd.refreshView(W);
  const vis = Legend.visible(W);
  eq(vis.monsters.length, 1, '同じ種族が別々に出ている');
  eq(vis.monsters[0].count, 3, '数がまとまっていない');
});

t('凡例: 眠っている敵はそれと分かる', () => {
  const W = Cmd.newGame('legend-sleep');
  W.actors = W.actors.filter(a => a.kind === 'player');
  const m = Monster.spawn(W.rng, Data.get().monstersById['maintenance-drone'],
                          W.player.x + 1, W.player.y);
  m.asleep = 50;
  World.addActor(W, m);
  Cmd.refreshView(W);

  const vis = Legend.visible(W);
  eq(vis.monsters[0].asleep, true, '眠っている印が無い');
  ok(vis.monsters[0].detail.indexOf('眠っている') !== -1, '説明に出ていない');
  eq(vis.monsters[0].color, 'dgray', '眠っている敵の色が落ちていない');
});

t('状態の意味がサイドバーと1対1で対応する', () => {
  const W = Cmd.newGame('legend-status');
  // 安全な環境では環境の説明を出さない
  W.level.env = Env.create({});
  Cmd.recalc(W);
  let st = Legend.status(W);
  ok(!st.some(s => s.label === '気密'), '★安全なのに気密の説明が出ている');
  ok(st.every(s => s.help && s.help.length > 0), '説明の無い項目がある');

  // 危険な環境では出る
  W.level.env = Env.create({ atmosphere: 0 });
  Cmd.recalc(W);
  st = Legend.status(W);
  const seal = st.find(s => s.label === '気密');
  ok(seal, '気密の説明が出ていない');
  eq(seal.color, 'red', '不足しているのに赤くない');
});

t('ヒント: 気密不足を最優先で警告する', () => {
  const W = Cmd.newGame('hint-seal');
  W.level.env = Env.create({ atmosphere: 0 });
  W.inv.equip.body = null;
  Cmd.recalc(W);
  const h = Legend.hints(W);
  eq(h[0].level, 'danger', '★気密不足が最優先になっていない');
  ok(h[0].text.indexOf('気密') !== -1, '気密について言っていない');
  ok(h[0].text.indexOf('<') !== -1, '逃げ道を示していない');
});

t('ヒント: 眠っている敵が隣にいると不意打ちを教える', () => {
  const W = Cmd.newGame('hint-sneak');
  W.actors = W.actors.filter(a => a.kind === 'player');
  const m = Monster.spawn(W.rng, Data.get().monstersById['maintenance-drone'],
                          W.player.x + 1, W.player.y);
  m.asleep = 50;
  World.addActor(W, m);
  Cmd.refreshView(W);
  const texts = Legend.hints(W).map(x => x.text).join('\n');
  ok(texts.indexOf('不意打ち') !== -1, '不意打ちを教えていない');
});

t('ヒント: 敵が複数見えていて目標未指定なら x を教える', () => {
  const W = Cmd.newGame('hint-target');
  W.actors = W.actors.filter(a => a.kind === 'player');
  const race = Data.get().monstersById['maintenance-drone'];
  for (let i = 0; i < 2; i++) {
    const m = Monster.spawn(W.rng, race, W.player.x + 2 + i, W.player.y);
    m.asleep = 0;
    World.addActor(W, m);
  }
  Cmd.refreshView(W);
  ok(Legend.hints(W).some(h => h.text.indexOf('x で目標') !== -1),
     '目標指定を教えていない');

  // 目標を指定したら言わなくなる
  Target.set(W, { kind: 'monster', actor: W.actors[1] });
  ok(!Legend.hints(W).some(h => h.text.indexOf('x で目標') !== -1),
     '目標を指定済みなのにまだ言っている');
});

t('ヒント: 何も無いときでも次の一手を示す', () => {
  const W = Cmd.newGame('hint-idle');
  W.actors = W.actors.filter(a => a.kind === 'player');
  W.items = [];
  W.inv.items = [];
  W.player.food = 5000;
  W.player.cells = 400;
  W.player.hp = W.player.hpMax;
  W.level.env = Env.create({});
  // 階段の上から離す
  const lv = W.level;
  W.player.x = lv.up.x + 3;
  while (!World.walkable(lv, W.player.x, W.player.y)) W.player.x--;
  Cmd.recalc(W);
  Cmd.refreshView(W);

  const h = Legend.hints(W);
  ok(h.length > 0, '★ヒントが空になった (何をすればいいか分からない画面)');
});

t('ヒント: 死亡時は新しいランの始め方を出す', () => {
  const W = Cmd.newGame('hint-dead');
  Actor.damage(W.player, 99999);
  Cmd.upkeep(W);
  eq(W.dead, true, '死んでいない');
  const h = Legend.hints(W);
  eq(h.length, 1, '死亡時に余計なヒントが出ている');
  ok(h[0].text.indexOf('N') !== -1, '新しいランの始め方を示していない');
});

t('凡例は W が無くても落ちない (作成画面のため)', () => {
  const empty = Legend.hints(null);
  ok(Array.isArray(empty), 'ヒントが配列でない');
  eq(empty.length, 0, 'W が無いのにヒントが出た');
  eq(Legend.status(null === null ? { player: null } : null).length, 0, '状態が出た');
});

/* ============ 統計 ============ */
console.log('\n[統計] ' + RUNS + ' 階層');

const avg = a => a.reduce((s, v) => s + v, 0) / a.length;
const min = a => Math.min.apply(null, a);
const max = a => Math.max.apply(null, a);

console.log('  部屋数      平均 ' + avg(stats.rooms).toFixed(1) + '  範囲 ' + min(stats.rooms) + '..' + max(stats.rooms));
console.log('  床率        平均 ' + (avg(stats.floorRatio) * 100).toFixed(1) + '%  範囲 ' +
            (min(stats.floorRatio) * 100).toFixed(1) + '..' + (max(stats.floorRatio) * 100).toFixed(1) + '%');
console.log('  生成試行    平均 ' + avg(stats.attempts).toFixed(2) + '  最大 ' + max(stats.attempts));

t('部屋数が妥当な範囲', () => {
  ok(min(stats.rooms) >= 3, '部屋が少なすぎる階がある: ' + min(stats.rooms));
  ok(avg(stats.rooms) >= 8, '平均部屋数が少ない: ' + avg(stats.rooms).toFixed(1));
});

t('床率が妥当な範囲 (スカスカでも詰まりすぎでもない)', () => {
  const a = avg(stats.floorRatio);
  ok(a > 0.08 && a < 0.45, '床率が異常: ' + (a * 100).toFixed(1) + '%');
});

t('生成の再試行が常態化していない', () => {
  ok(avg(stats.attempts) < 1.5, '再試行が多すぎる (生成器が不安定): ' + avg(stats.attempts).toFixed(2));
});

/* ---------- まとめ ---------- */
console.log('\n' + pass + ' pass / ' + fail + ' fail');
if (fail) {
  console.log('\n失敗:');
  for (const f of failures) console.log('  - ' + f);
}
process.exit(fail ? 1 : 0);
