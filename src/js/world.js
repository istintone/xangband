/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* world.js — 世界状態 W と階層(Level)の定義。DOM 非依存。
 *
 * M0 の時点では「地形 + プレイヤー位置 + メッセージ」だけ。
 * アクター/アイテムは M1 で足す (docs/04 §M1)。
 */
'use strict';

var World = (function () {

  /* --- 地形 --- */
  var TILE = {
    WALL:  0,   // 掘られていない構造材
    FLOOR: 1,   // 床
    DOOR:  2,   // 隔壁扉 (M0 では常時開。開閉は M1)
    DOWN:  3,   // 降下シャフト
    UP:    4,   // 昇降機
    TRAP:  5,   // 設備障害 (破断配管・電磁トラップ・自動砲座)
    SHOP:  6,   // 交易区の入口 (深度0の母船のみ)
    TERM:  7    // 端末。J で接続する (docs/11 §11.3)
  };

  /* 地形ごとの性質。ここを見れば「通れるか」「視線を遮るか」が分かる。 */
  var TILE_INFO = {};
  TILE_INFO[TILE.WALL]  = { name: '構造材',       walk: false, blockSight: true  };
  TILE_INFO[TILE.FLOOR] = { name: '床',           walk: true,  blockSight: false };
  TILE_INFO[TILE.DOOR]  = { name: '隔壁扉',       walk: true,  blockSight: false };
  TILE_INFO[TILE.DOWN]  = { name: '降下シャフト', walk: true,  blockSight: false };
  TILE_INFO[TILE.UP]    = { name: '昇降機',       walk: true,  blockSight: false };
  TILE_INFO[TILE.TRAP]  = { name: '設備障害',     walk: true,  blockSight: false };
  TILE_INFO[TILE.SHOP]  = { name: '区画入口',     walk: true,  blockSight: false };
  TILE_INFO[TILE.TERM]  = { name: '端末',         walk: true,  blockSight: false };

  /* --- グリッドのフラグ (ビットマスク) --- */
  var F = {
    KNOWN:   1,  // 一度でも見た = 記憶に残っている (薄色で描画)
    VISIBLE: 2,  // 今この瞬間 見えている
    GLOW:    4   // 常時照明区画 (docs/02 §2.2)
  };

  /**
   * 階層を作る。tiles/flags は TypedArray なので、
   * 大きなマップでも生成のたびに GC を騒がせない。
   */
  function createLevel(w, h) {
    return {
      w: w, h: h,
      tiles: new Uint8Array(w * h),   // 既定値 0 = WALL
      flags: new Uint8Array(w * h),
      rooms: [],                       // 生成器が記録する矩形 (デバッグ・部屋照明用)
      depth: 0,
      up: null, down: null             // 階段座標 {x,y}
    };
  }

  function idx(lv, x, y) { return y * lv.w + x; }
  function inBounds(lv, x, y) { return x >= 0 && y >= 0 && x < lv.w && y < lv.h; }

  function getTile(lv, x, y) {
    return inBounds(lv, x, y) ? lv.tiles[y * lv.w + x] : TILE.WALL;
  }
  function setTile(lv, x, y, t) {
    if (inBounds(lv, x, y)) lv.tiles[y * lv.w + x] = t;
  }

  function walkable(lv, x, y) { return TILE_INFO[getTile(lv, x, y)].walk; }
  function blocksSight(lv, x, y) { return TILE_INFO[getTile(lv, x, y)].blockSight; }

  function hasFlag(lv, x, y, f) {
    return inBounds(lv, x, y) && (lv.flags[y * lv.w + x] & f) !== 0;
  }
  function addFlag(lv, x, y, f) {
    if (inBounds(lv, x, y)) lv.flags[y * lv.w + x] |= f;
  }
  function clearFlagAll(lv, f) {
    var inv = ~f;
    for (var i = 0; i < lv.flags.length; i++) lv.flags[i] &= inv;
  }

  /* --- 世界状態 W --- */
  /**
   * @param {string} seed ランのシード。これ1つで全生成が決まる。
   */
  function createWorld(seed) {
    var rng = RNG.create(seed);
    var W = {
      seed: rng.seed,
      rng: rng,
      turn: 0,                                  // ゲームターン (docs/02 §2.1)
      depth: 0,
      level: null,
      player: null,                             // Player.create() で入れる
      actors: [],                               // プレイヤーを含む全アクター
      items: [],                                // 床のアイテム
      inv: null,                                // Inventory.create()
      messages: [],                             // 新しいものが末尾
      dead: false,
      grave: null,                              // 死亡時の墓碑 (docs/02 §2.12)
      nextActorId: 1,
      // --- M2 ---
      knowledge: null,                          // 刻印とフレーバーの知識 (sigil.js)
      lore: {},                                 // 敵の知識 (lore.js)
      uniquesMade: {},                          // 生成済みの固有機材 ([[D-38]])
      uniquesKilled: {},                        // 倒したユニーク
      loreFound: {},                            // 読んだログ断片 (docs/07 §7.8)
      returning: false,                         // 帰還フェーズ (docs/07 §7.5)
      won: false,                               // 勝利したか
      devRun: false,                            // 開発用起動 ([[D-66]])
      netDone: {},                              // この階で通した操作 (docs/11 §11.3)
      netBlindUntil: 0,                         // 監視を切っている期限
      modules: {},                              // 解体で得たモジュール (docs/11 §11.4)
      parts: 0,                                 // 移植に要るレアパーツ敵
      feeling: { danger: 0, loot: 0, lootKnown: false },  // 階の予感
      shops: null,                              // 交易区の在庫
      home: [],                                 // 格納庫(倉庫)
      recallPending: 0,                         // 帰投までの残りターン
      flow: null,                               // 音のマップ ([[D-35]])
      site: null,                               // 現在のサイト定義 (M3b)
      progress: null,                           // サイトごとの到達最深度と《適合》
      target: null,                             // 指定した目標 ([[D-49]])
      alerted: false,                           // 監視に補足されたか (docs/08 §8.3)
      /* 被ダメの内訳。「環境ダメージが総被ダメの15〜35%」を測るために要る
         ([[D-53]])。飾りでも理不尽でもないことを数値で示す唯一の手段。 */
      tally: { env: 0, foe: 0 }
    };
    return W;
  }

  /* --- アクターの出入り --- */

  function addActor(W, a) {
    a.id = W.nextActorId++;
    W.actors.push(a);
    return a;
  }

  function removeActor(W, a) {
    var i = W.actors.indexOf(a);
    if (i !== -1) W.actors.splice(i, 1);
  }

  /** その座標に居るアクター。居なければ null。 */
  function actorAt(W, x, y) {
    for (var i = 0; i < W.actors.length; i++) {
      var a = W.actors[i];
      if (!a.dead && a.x === x && a.y === y) return a;
    }
    return null;
  }

  /** 死んだアクターを配列から掃除する。プレイヤーは残す(墓碑のため)。 */
  function reapDead(W) {
    for (var i = W.actors.length - 1; i >= 0; i--) {
      if (W.actors[i].dead && W.actors[i].kind !== 'player') W.actors.splice(i, 1);
    }
  }

  /** メッセージ行に出す。直前と同じ文言なら「(xN)」でまとめる。 */
  function msg(W, text) {
    var last = W.messages[W.messages.length - 1];
    if (last && last.text === text) { last.count++; return; }
    W.messages.push({ text: text, count: 1, turn: W.turn });
    if (W.messages.length > 200) W.messages.shift();
  }

  /* --- セーブ用の直列化 (docs/01 §1.4) ---
     localStorage への書き込みは save.js (shell層) が行う。
     ここは「状態 <-> プレーンなオブジェクト」の変換だけを持つので、
     ヘッドレスでもセーブ往復をテストできる。 */

  var SAVE_SCHEMA = 3;

  function serialize(W) {
    return {
      schema: SAVE_SCHEMA,
      seed: W.seed,
      rng: W.rng.state(),
      turn: W.turn,
      depth: W.depth,
      dead: W.dead,
      grave: W.grave,
      nextActorId: W.nextActorId,
      messages: W.messages.slice(-30),
      inv: W.inv,
      items: W.items,
      knowledge: W.knowledge,
      lore: W.lore,
      uniquesMade: W.uniquesMade,
      uniquesKilled: W.uniquesKilled,
      loreFound: W.loreFound,
      returning: W.returning, won: W.won, devRun: W.devRun,
      netDone: W.netDone, netBlindUntil: W.netBlindUntil,
      modules: W.modules, parts: W.parts,
      feeling: W.feeling,
      shops: W.shops,
      home: W.home,
      recallPending: W.recallPending,
      /* サイトは**定義そのものではなく id** を保存する。
         定義を焼き込むと、sites.json を直した後もセーブが古い値を持ち続ける。 */
      siteId: W.site ? W.site.id : null,
      alerted: W.alerted,
      alertLevel: W.alertLevel,
      reinforceAt: W.reinforceAt,
      progress: W.progress,
      tally: W.tally,
      actors: W.actors.map(function (a) {
        var c = {};
        for (var k in a) if (k !== 'target') c[k] = a[k];
        c.target = a.target ? { x: a.target.x, y: a.target.y } : null;
        return c;
      }),
      level: {
        w: W.level.w, h: W.level.h, depth: W.level.depth,
        rooms: W.level.rooms, up: W.level.up, down: W.level.down, env: W.level.env,
        night: W.level.night,
        tiles: Array.prototype.slice.call(W.level.tiles),
        flags: Array.prototype.slice.call(W.level.flags),
        // 方舟の区画気圧。失うとロード後に階の空気が変わってしまう
        pressure: W.level.pressure ? Array.prototype.slice.call(W.level.pressure) : null
      }
    };
  }

  function deserialize(save) {
    if (save.schema !== SAVE_SCHEMA) {
      throw new Error('セーブの schema が非対応: ' + save.schema + ' (期待 ' + SAVE_SCHEMA + ')');
    }
    var W = createWorld(save.seed);
    W.rng.setState(save.rng);
    W.turn = save.turn;
    W.depth = save.depth;
    W.dead = save.dead;
    W.grave = save.grave;
    W.nextActorId = save.nextActorId;
    W.messages = save.messages || [];
    W.inv = save.inv;
    W.items = save.items;
    W.actors = save.actors;
    W.knowledge = save.knowledge;
    W.lore = save.lore || {};
    W.uniquesMade = save.uniquesMade || {};
    W.uniquesKilled = save.uniquesKilled || {};
    W.loreFound = save.loreFound || {};
    W.returning = !!save.returning;
    W.won = !!save.won;
    W.devRun = !!save.devRun;
    W.netDone = save.netDone || {};
    W.netBlindUntil = save.netBlindUntil || 0;
    W.modules = save.modules || {};
    W.parts = save.parts || 0;
    W.feeling = save.feeling || { danger: 0, loot: 0, lootKnown: false };
    W.shops = save.shops || null;
    W.home = save.home || [];
    W.recallPending = save.recallPending || 0;
    W.site = save.siteId ? Site.byId(save.siteId) : null;
    W.alerted = !!save.alerted;
    W.alertLevel = save.alertLevel || 0;
    W.reinforceAt = save.reinforceAt || 0;
    W.progress = save.progress || null;
    W.tally = save.tally || { env: 0, foe: 0 };
    W.player = null;
    for (var i = 0; i < W.actors.length; i++) {
      if (W.actors[i].kind === 'player') W.player = W.actors[i];
    }
    if (!W.player) throw new Error('セーブにプレイヤーが居ない');

    var s = save.level;
    var lv = createLevel(s.w, s.h);
    lv.depth = s.depth; lv.rooms = s.rooms; lv.up = s.up; lv.down = s.down;
    lv.env = s.env || null;
    lv.night = s.night;
    if (s.pressure) { lv.pressure = new Uint8Array(s.pressure.length); lv.pressure.set(s.pressure); }
    lv.tiles.set(s.tiles);
    lv.flags.set(s.flags);
    W.level = lv;
    return W;
  }

  return {
    TILE: TILE, TILE_INFO: TILE_INFO, F: F, SAVE_SCHEMA: SAVE_SCHEMA,
    createLevel: createLevel, createWorld: createWorld,
    idx: idx, inBounds: inBounds,
    getTile: getTile, setTile: setTile,
    walkable: walkable, blocksSight: blocksSight,
    hasFlag: hasFlag, addFlag: addFlag, clearFlagAll: clearFlagAll,
    addActor: addActor, removeActor: removeActor, actorAt: actorAt, reapDead: reapDead,
    serialize: serialize, deserialize: deserialize,
    msg: msg
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = World;
