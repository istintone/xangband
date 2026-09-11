/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* boot.js — 起動と入力ディスパッチ。shell 層。
 * 副作用を持つので結合順は必ず最後 (docs/01 §1.2)。
 *
 * ゲームの判断は cmd.js (rule層) にある。ここは
 * 「入力を cmd に渡し、結果を描く」だけに留める。
 */
'use strict';

(function () {

  var W = null;
  var canvas = null;
  var panelToggle = null, panelApp = null;

  var draft = { lineage: null, role: null, hover: 0 };

  function redraw() {
    var buf = Render.frame(W);
    UI.overlay(buf, W, draft);
    Term.draw(buf);
    Panel.refresh(W);              // 枠外UI も同時に更新 ([[D-55]])
  }

  /* ---- UI が開いているときの選択 ---- */

  /**
   * 一覧の n 番目を選んだ。
   * **一覧の内容は UI.listFor が唯一の正本** ([[D-51]])。
   * 描画と選択が同じものを見るので、順序がズレる余地が無い。
   */
  function handleSelect(index) {
    var mode = UI.current();
    var list = UI.listFor(W, mode);
    var picked = list[index];
    if (picked === undefined) return;

    switch (mode) {
      case 'equip':
        Cmd.step(W, { type: 'unequip', slot: picked });
        UI.close();
        return;

      case 'ability':
        Cmd.step(W, { type: 'ability', id: picked.id });
        UI.close();
        return;

      case 'learn': {
        var lr = Ability.learn(W, W.player, picked.id);
        if (!lr.ok) World.msg(W, lr.reason);
        UI.open('ability');
        return;
      }

      case 'shop': {
        var res = Hub.buy(W, UI.ctx(), index);
        World.msg(W, res.ok
          ? Inventory.label(res.item, W.knowledge) + 'を ' + res.price + 'cr で購入した。'
          : res.reason);
        Cmd.recalc(W);
        return;
      }

      case 'sell': {
        var sr = Hub.sell(W, UI.ctx(), picked);
        World.msg(W, sr.ok ? sr.price + 'cr で売却した。' : sr.reason);
        Cmd.recalc(W);
        return;
      }

      case 'home': {
        var hr = Hub.retrieve(W, index);
        World.msg(W, hr.ok ? Inventory.label(hr.item, W.knowledge) + 'を取り出した。' : hr.reason);
        Cmd.recalc(W);
        return;
      }

      case 'store': {
        var stored = Hub.store(W, picked);
        World.msg(W, stored.ok ? '預けた。' : stored.reason);
        Cmd.recalc(W);
        UI.open('home');
        return;
      }

      case 'lore':
        if (!UI.ctx()) UI.open('lore', picked);
        return;

      case 'salvage': {
        var sr = Craft.salvage(W, picked);
        if (!sr.ok) World.msg(W, sr.reason);
        Cmd.recalc(W);
        UI.open('salvage');                      // 続けて解体できる
        return;
      }

      case 'module':
        UI.open('graft', picked.id);             // 移植先を選ぶ
        return;

      case 'graft': {
        var gr = Craft.transplant(W, picked, UI.ctx());
        if (!gr.ok) { World.msg(W, gr.reason); return; }
        Cmd.recalc(W);
        UI.close();
        return;
      }

      case 'display':
        Theme.set(picked.kind, picked.id);
        draw();
        return;

      case 'act':
        /* 文脈アクションは**キー入力と同じ経路**を通す ([[D-57]] [[D-85]])。
           ここで直接 Cmd を呼ぶと、キーとメニューで挙動がズレる。 */
        UI.close();
        exec(picked.cmd);
        return;

      case 'net': {
        if (!Net.atTerminal(W)) { World.msg(W, 'ここに端末は無い。'); UI.close(); return; }
        UI.close();
        step({ type: 'jack', id: picked.id });
        return;
      }

      case 'site': {
        if (W.depth !== 0) { World.msg(W, '母船でしか降下先は変えられない。'); UI.close(); return; }
        var sr = Cmd.selectSite(W, picked.id);
        if (!sr.ok) World.msg(W, sr.reason);
        else UI.close();
        return;
      }

      case 'lineage':
        draft.lineage = picked.id;
        draft.hover = 0;
        UI.open('role');
        return;

      case 'role':
        draft.role = picked.id;
        startNew(null, draft.lineage, draft.role);
        return;

      case 'use':  Cmd.step(W, { type: 'use', item: picked }); UI.close(); return;
      case 'wear': Cmd.step(W, { type: 'equip', item: picked }); UI.close(); return;
      case 'drop': Cmd.step(W, { type: 'drop', item: picked }); UI.close(); return;
      default: return;                              // 'inventory' は閲覧のみ
    }
  }

  /**
   * マップのクリック ([[D-57]])。
   * ボタンだけ押せても、狙う相手を選べなければ遊べない。
   *   隣接マス → そこへ移動(敵がいれば攻撃)
   *   敵       → 目標に指定
   *   それ以外 → その場所を注視
   */
  function clickMap(cell) {
    if (!W || !W.player || W.dead) return;

    // 端末セル -> マップ座標
    var mx = cell.x - Render.MAP.x, my = cell.y - Render.MAP.y;
    if (mx < 0 || my < 0 || mx >= Render.MAP.w || my >= Render.MAP.h) return;
    var focus = W.cursor || W.player;
    var o = Render.viewOrigin(W.level, focus.x, focus.y);
    var wx = o.x + mx, wy = o.y + my;
    if (!World.inBounds(W.level, wx, wy)) return;

    // 注視モード中はカーソルを飛ばす
    if (UI.current() === 'look') {
      W.cursor.x = wx; W.cursor.y = wy; W.cursor.index = -1;
      redraw();
      return;
    }
    if (UI.isOpen()) return;                       // 他のメニュー中は無視

    var p = W.player;
    var what = Target.at(W, wx, wy);

    // 隣接マスなら移動/攻撃
    if (U.distCheb(wx, wy, p.x, p.y) === 1) {
      Cmd.step(W, { type: 'move', dx: wx - p.x, dy: wy - p.y });
      checkEnd();
      redraw();
      return;
    }

    // 敵なら目標に
    if (what.kind === 'monster') {
      Target.set(W, what);
      World.msg(W, what.actor.name + 'を目標にした。');
    } else if (World.hasFlag(W.level, wx, wy, World.F.KNOWN) &&
               World.walkable(W.level, wx, wy)) {
      /* 既に見た場所なら、そこまで歩く ([[D-86]])。
         オートエクスプロアではない ―― 行き先はプレイヤーが指している。 */
      exec({ type: 'travel', x: wx, y: wy });
      return;
    } else {
      W.cursor = { x: wx, y: wy, index: -1 };
      UI.open('look');
    }
    redraw();
  }

  /** 母船の区画に入る。 */
  function enterHere() {
    if (W.depth !== 0) { World.msg(W, 'ここには何もない。'); return; }
    var id = Hub.shopAt(W.level, W.player.x, W.player.y);
    if (!id) { World.msg(W, 'ここには何もない。'); return; }
    if (id === 'home') UI.open('home');
    else UI.open('shop', id);
  }

  /** 情報屋/工房の役務。 */
  function runService(name) {
    var r, i;
    if (name === 'analyze') {
      var target = null;
      for (i = 0; i < W.inv.items.length; i++) {
        var cand = W.inv.items[i];
        if (cand.slot && !Sigil.fullyKnown(W.knowledge, cand)) { target = cand; break; }
      }
      if (!target) {
        for (i = 0; i < Inventory.SLOTS.length; i++) {
          var e = W.inv.equip[Inventory.SLOTS[i]];
          if (e && !Sigil.fullyKnown(W.knowledge, e)) { target = e; break; }
        }
      }
      if (!target) { World.msg(W, '解析するものが無い。'); return; }
      r = Hub.analyzeService(W, target);
      World.msg(W, r.ok ? Sigil.name(W.knowledge, target) + 'を解析した。(' + r.price + 'cr)' : r.reason);
    } else if (name === 'cure') {
      r = Hub.cureService(W);
      World.msg(W, r.ok ? '治療を受けた。(' + r.price + 'cr)' : r.reason);
    } else if (name === 'repair') {
      r = Hub.repairService(W);
      World.msg(W, r.ok ? r.count + ' 点を修理した。(' + r.price + 'cr)' : r.reason);
    } else if (name === 'salvage') {
      UI.open('salvage');
      return;                                    // 一覧から選ばせる
    } else if (name === 'graft') {
      if (!Craft.moduleList(W).length) {
        World.msg(W, 'モジュールを持っていない。まず解体すること。');
        return;
      }
      UI.open('module');                         // モジュール → 装備 の順に選ぶ
      return;
    }
    Cmd.recalc(W);
  }

  /* ---- 入力ディスパッチ ---- */

  function exec(cmd) {
    switch (cmd.type) {
      case 'close':
        // 詳細/下位メニューからは一段戻る
        if (UI.current() === 'look') { W.cursor = null; UI.close(); }
        else if (UI.current() === 'lore' && UI.ctx()) UI.open('lore');
        else if (UI.current() === 'sell') UI.open('shop', UI.ctx());
        else if (UI.current() === 'store') UI.open('home');
        else if (UI.current() === 'learn') UI.open('ability');
        else if (UI.current() === 'graft') UI.open('module');
        else UI.close();
        break;

      case 'select':
        handleSelect(cmd.index);
        break;

      case 'menuMove':
        UI.moveCursor(cmd.delta, UI.listFor(W, UI.current()).length);
        draw();
        break;

      case 'menuPick':
        handleSelect(UI.cursorAt());
        break;

      case 'menu':
        // メニューを開く/閉じるはターンを消費しないメタ操作 (docs/01 不変条件4)
        UI.open(UI.current() === cmd.mode ? null : cmd.mode);
        break;

      case 'enter':
        enterHere();
        break;

      case 'panels':
        cyclePanels();
        break;

      case 'learnMenu':
        UI.open('learn');
        break;

      case 'sellMenu':
        UI.open('sell', UI.ctx());
        break;

      case 'storeMenu':
        UI.open('store');
        break;

      case 'service':
        runService(cmd.name);
        break;

      /* --- 注視 / 目標指定 ([[D-49]]) --- */
      case 'look':
        W.cursor = Target.createCursor(W);
        Target.cycle(W, W.cursor, 1);              // 最初の候補へ
        UI.open('look');
        break;

      case 'lookCycle':
        if (W.cursor) Target.cycle(W, W.cursor, cmd.dir);
        break;

      case 'lookMove':
        if (W.cursor) Target.move(W, W.cursor, cmd.dx, cmd.dy);
        break;

      case 'lookTarget': {
        var what = Target.at(W, W.cursor.x, W.cursor.y);
        if (Target.set(W, what)) World.msg(W, what.actor.name + 'を目標にした。');
        else World.msg(W, 'そこに目標にできるものは無い。');
        W.cursor = null;
        UI.close();
        break;
      }

      /* --- 休息と連続移動 ([[D-50]]) --- */
      case 'rest':
        Cmd.rest(W);
        checkEnd();
        break;

      case 'travel':
        Cmd.travel(W, cmd.x, cmd.y);
        checkEnd();
        break;

      case 'lookTravel':
        if (W.cursor) {
          var cx = W.cursor.x, cy = W.cursor.y;
          W.cursor = null;
          UI.close();
          Cmd.travel(W, cx, cy);
          checkEnd();
        }
        break;

      case 'run':
        Cmd.run(W, cmd.dx, cmd.dy);
        checkEnd();
        break;

      /* --- キャラクター作成 (docs/09 §9.7) --- */
      case 'createHover': {
        var clist = UI.listFor(W, UI.current());
        draft.hover = U.clamp(draft.hover + cmd.delta, 0, Math.max(0, clist.length - 1));
        break;
      }

      case 'createRandom': {
        // 乱数は必ず RNG 経由 (不変条件1 — [[D-11]])。
        // 作成画面はまだ世界が無いので、時刻から使い捨てのRNGを作る。
        var rlist = UI.listFor(W, UI.current());
        if (rlist.length) {
          var r = RNG.create('create/' + Date.now());
          handleSelect(r.int(rlist.length));
        }
        break;
      }

      case 'createBack':
        if (UI.current() === 'role') { draft.hover = 0; UI.open('lineage'); }
        break;

      case 'newseed':
        beginCreate();
        break;

      case 'regen':
        Cmd.enterLevel(W, W.depth, false);
        World.msg(W, '同一シードで再生成。');
        break;

      case 'save': {
        var r = Save.save(W);
        World.msg(W, r.ok ? 'セーブした。' : r.reason);
        break;
      }

      case 'load': {
        var l = Save.load();
        if (l.ok) { W = l.world; Item.syncNextId(W.items); Cmd.refreshView(W); World.msg(W, 'ロードした。'); }
        else World.msg(W, l.reason);
        break;
      }

      default:
        if (W.dead) break;
        Cmd.step(W, cmd);
        if (W.dead) {
          Save.recordDeath(W);
          UI.open('grave');
        }
        break;
    }
    redraw();
  }

  /* ---- 起動 ---- */

  function startNew(seed, lineageId, roleId) {
    W = Cmd.newGame(seed, lineageId, roleId);
    draft = { lineage: null, role: null, hover: 0 };
    UI.close();
  }

  /** キャラクター作成に入る。系統 → ロール → 開始。 */
  function beginCreate() {
    draft = { lineage: null, role: null, hover: 0 };
    UI.open('lineage');
  }

  function start() {
    canvas = document.getElementById('term');
    Term.init(canvas);
    Data.init(RAW);

    // 表示設定 (docs/09 §9.9)。パレットを差し替えてから最初の描画に入る
    Theme.init(function () { if (W) draw(); });
    // URL で配色を指定できる (docs/09 §9.7 の再現用と同じ趣旨)
    var mt = /[?&]theme=([^&]+)/.exec(window.location.search);
    var ms = /[?&]scale=([^&]+)/.exec(window.location.search);
    if (mt) Theme.set('palette', decodeURIComponent(mt[1]));
    if (ms) Theme.set('scale', decodeURIComponent(ms[1]));

    // 枠外UI (docs/09 §9.11)。ボタンはキーと同じ exec を通る ([[D-57]])。
    Panel.init({
      commands: document.getElementById('cmdpanel'),
      legend: document.getElementById('legend'),
      guide: document.getElementById('guide'),
      log: document.getElementById('log')
    }, exec);
    Term.onClick(clickMap);

    panelToggle = document.getElementById('toggle');
    panelApp = document.getElementById('app');
    if (panelToggle && panelApp) {
      /* 狭い画面では左右のパネルが端末に重なるので、既定は「簡易」。
         広い画面では全部出す ([[D-83]])。 */
      // URL で指定できる (スクリーンショットと再現用)
      var mp = /[?&]panels=([^&]+)/.exec(window.location.search);
      /* 携帯(760px以下)は縦積みで全部入るので、畳まずに出す ([[D-87]])。
         中くらいの幅では左右が端末に重なるので「簡易」から始める。 */
      var auto = window.innerWidth <= 760 ? 'full'
               : (window.innerWidth <= 900 ? 'slim' : 'full');
      Panel.setMode(panelApp, panelToggle, mp ? decodeURIComponent(mp[1]) : auto);
      Term.relayout();
      panelToggle.addEventListener('click', function () {
        cyclePanels();
      });
    }

    /**
   * 枠外UI の表示量を次の段へ回す ([[D-83]])。
   * 端末はそのぶん広くなるので、必ず再レイアウトする。
   */
  function cyclePanels() {
    if (!panelApp) return;
    var m = Panel.cycleMode(panelApp, panelToggle);
    Term.relayout();
    Term.focus();
    if (W) World.msg(W, '表示: ' + m.name);
    draw();
  }

  /** 死亡または勝利で画面を切り替える。呼び出し側で分岐を書かない。 */
  function checkEnd() {
    if (W.won && !W.endShown) { W.endShown = true; Save.recordVictory(W); UI.open('grave'); }
    else if (W.dead && !W.endShown) { W.endShown = true; Save.recordDeath(W); UI.open('grave'); }
  }

  // URL に ?seed=...&lin=...&role=... があればそれを使う (再現用 — docs/09 §9.7)
    var q = window.location.search;
    var m = /[?&]seed=([^&]+)/.exec(q);
    var ml = /[?&]lin=([^&]+)/.exec(q);
    var mr = /[?&]role=([^&]+)/.exec(q);
    var md = /[?&]dev=([^&]+)/.exec(q);          // 開発用起動 ([[D-66]] / docs/07 §7.9)
    if (m || md) {
      startNew(m ? decodeURIComponent(m[1]) : 'dev',
               ml ? decodeURIComponent(ml[1]) : null,
               mr ? decodeURIComponent(mr[1]) : null);
      if (md) DevStart.apply(W, decodeURIComponent(md[1]));
    } else if (Save.hasSave()) {
      var l = Save.load();
      if (l.ok) {
        W = l.world;
        Item.syncNextId(W.items);
        Cmd.refreshView(W);
        World.msg(W, '続きから再開した。');
      } else {
        beginCreate();
      }
    } else {
      beginCreate();
    }

    Input.attach(canvas, exec);
    redraw();
    Term.focus();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
