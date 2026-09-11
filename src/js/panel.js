/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* panel.js — 枠外UI。shell 層。docs/09 §9.11, §9.16 ([[D-55]] [[D-82]])。
 *
 * Canvas 疑似端末の**外**に DOM で置く。端末 80x40 を情報で埋めないため。
 * 何を説明するかは legend.js (rule層) が決める。ここは DOM を組むだけ。
 *
 *   #cmdpanel 操作パネル(左)    #legend HUD(右)
 *   #guide    いま何をすべきか   #log    メッセージ履歴   … どちらも中央下部
 *
 * ガイドを HUD から分けたのは、**性質が違う**から ([[D-82]])。
 * HUD は「今あるもの」の説明、ガイドは「次にすること」の促し。
 * 盤面の真下に置くほうが視線の移動が短い。
 *
 * ボタンのクリックは**キー入力と同じ経路**を通す ([[D-57]])。
 * 経路を分けるとキーとボタンで挙動がズレるため。
 */
'use strict';

var Panel = (function () {

  var cmdEl = null, legendEl = null, guideEl = null, logEl = null;
  var dispatch = null;

  /* 操作パネルの内容。cmd はそのまま boot の exec へ渡る。 */
  var GROUPS = [
    {
      name: '移動', items: [
        { key: 'Space', label: '今できること', cmd: { type: 'menu', mode: 'act' },
          note: '迷ったらこれ' },
        { key: '↑↓←→', label: '歩く', cmd: null, note: 'テンキー / hjklyubn も可' },
        { key: 'Shift+方向', label: '走る', cmd: null, note: '何かあるまで進む' },
        { key: '.', label: '待つ', cmd: { type: 'move', dx: 0, dy: 0 } },
        { key: 'R', label: '休息', cmd: { type: 'rest' }, note: 'HP が満ちるまで' }
      ]
    },
    {
      name: '戦う', items: [
        { key: '方向', label: '殴る', cmd: null, note: '敵の方向へ移動' },
        { key: 'x', label: '目標を選ぶ', cmd: { type: 'look' }, note: 'マップのクリックでも可' },
        { key: 'f', label: '撃つ', cmd: { type: 'shoot' }, need: 'launcher' },
        { key: 'm', label: '能力', cmd: { type: 'menu', mode: 'ability' }, need: 'ability' }
      ]
    },
    {
      name: '調べる', items: [
        { key: 'x', label: '注視', cmd: { type: 'look' } },
        { key: 'C', label: 'キャラクター', cmd: { type: 'menu', mode: 'char' } },
        { key: 'M', label: '敵の知識', cmd: { type: 'menu', mode: 'lore' } },
        { key: '^P', label: 'メッセージ履歴', cmd: { type: 'menu', mode: 'log' } },
        { key: '?', label: '操作一覧', cmd: { type: 'menu', mode: 'help' } },
        { key: '=', label: '表示設定', cmd: { type: 'menu', mode: 'display' },
          note: '配色・文字サイズ' },
        { key: '\\', label: 'パネルの量', cmd: { type: 'panels' },
          note: '全表示 / 簡易 / 非表示' }
      ]
    },
    {
      name: '持ち物', items: [
        { key: 'g', label: '拾う', cmd: { type: 'pickup' } },
        { key: 'i', label: '所持品', cmd: { type: 'menu', mode: 'inventory' } },
        { key: 'u', label: '使う', cmd: { type: 'menu', mode: 'use' } },
        { key: 'w', label: '装備する', cmd: { type: 'menu', mode: 'wear' } },
        { key: 'e', label: '装備一覧', cmd: { type: 'menu', mode: 'equip' } },
        { key: 'd', label: '置く', cmd: { type: 'menu', mode: 'drop' } },
        { key: 'L', label: 'ライト入切', cmd: { type: 'light' } },
        { key: 'J', label: '接続する', cmd: { type: 'menu', mode: 'net' }, note: '端末 Ω の上で' },
        { key: 'B', label: '解体する', cmd: { type: 'service', name: 'salvage' }, note: '母船の工房で' },
        { key: 'G', label: '移植する', cmd: { type: 'service', name: 'graft' }, note: '母船の工房で' }
      ]
    },
    {
      name: '進む', items: [
        { key: '>', label: '降りる', cmd: { type: 'descend' } },
        { key: '<', label: '戻る', cmd: { type: 'ascend' } },
        { key: 'Enter', label: '区画に入る', cmd: { type: 'enter' }, note: '母船のみ' },
        { key: 'V', label: '降下先を選ぶ', cmd: { type: 'menu', mode: 'site' }, note: '母船のみ' }
      ]
    },
    {
      name: 'システム', items: [
        { key: 'S', label: 'セーブ', cmd: { type: 'save' } },
        { key: '^L', label: 'ロード', cmd: { type: 'load' } },
        { key: 'N', label: '新しいラン', cmd: { type: 'newseed' } },
        { key: 'ESC', label: '閉じる', cmd: { type: 'close' } }
      ]
    }
  ];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /* ---------- 操作パネル ---------- */

  function buildCommands() {
    cmdEl.innerHTML = '';
    cmdEl.appendChild(el('h2', 'p-title', '操作'));
    cmdEl.appendChild(el('p', 'p-note', 'クリックでも、キーでも動く。'));

    for (var g = 0; g < GROUPS.length; g++) {
      var group = GROUPS[g];
      var sec = el('section', 'p-group');
      sec.appendChild(el('h3', null, group.name));

      for (var i = 0; i < group.items.length; i++) {
        var item = group.items[i];
        var row = el('button', 'p-cmd');
        row.type = 'button';
        row.appendChild(el('span', 'p-key', item.key));
        row.appendChild(el('span', 'p-label', item.label));
        if (item.note) row.appendChild(el('span', 'p-sub', item.note));

        if (item.cmd) {
          row.dataset.cmd = JSON.stringify(item.cmd);
        } else {
          row.classList.add('p-info');       // 説明だけの行(押しても何も起きない)
          row.disabled = true;
        }
        if (item.need) row.dataset.need = item.need;
        sec.appendChild(row);
      }
      cmdEl.appendChild(sec);
    }

    // クリックはキーと同じ経路へ ([[D-57]])
    cmdEl.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.p-cmd') : null;
      if (!btn || !btn.dataset.cmd || btn.disabled) return;
      dispatch(JSON.parse(btn.dataset.cmd));
    });
  }

  /** 使えないコマンドを淡色にする。 */
  function refreshCommands(W) {
    if (!cmdEl) return;
    var buttons = cmdEl.querySelectorAll('.p-cmd[data-need]');
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      var ok = true;
      if (!W || !W.player) ok = false;
      else if (b.dataset.need === 'launcher') ok = !!W.inv.equip.launcher;
      else if (b.dataset.need === 'ability') ok = !!W.player.system && W.player.abilities.length > 0;
      b.classList.toggle('p-off', !ok);
    }
  }

  /* ---------- 凡例HUD ---------- */

  function buildLegend() {
    legendEl.innerHTML = '';
    legendEl.appendChild(el('h2', 'p-title', 'いま見えているもの'));
    /* 横一列の要約。携帯では端末のサイドバーを畳む ([[D-87]]) ので、
       その中身をここが受け持つ。広い画面では CSS が隠す。 */
    legendEl.appendChild(el('div', 'l-strip'));
    legendEl.appendChild(el('div', 'l-body'));
  }

  /** 端末のサイドバーと同じ値を、横に並べた札で出す。 */
  function refreshStrip(W) {
    var strip = legendEl && legendEl.querySelector('.l-strip');
    if (!strip) return;
    strip.innerHTML = '';
    if (!W || !W.player) return;

    var rows = Legend.status(W);
    for (var i = 0; i < rows.length; i++) {
      var chip = el('span', 'l-chip');
      chip.appendChild(el('span', 'l-chip-k', rows[i].label));
      chip.appendChild(el('span', 'l-chip-v', rows[i].value));
      if (rows[i].color) chip.style.color = color(rows[i].color);
      chip.title = rows[i].help;
      strip.appendChild(chip);
    }
  }

  function color(name) { return Render.PALETTE[name] || Render.PALETTE.white; }

  function glyphRow(entry) {
    var row = el('div', 'l-row');
    var g = el('span', 'l-glyph', entry.ch);
    g.style.color = color(entry.color);
    row.appendChild(g);
    var name = entry.label + (entry.count > 1 ? ' ×' + entry.count : '');
    row.appendChild(el('span', 'l-name', name));
    if (entry.detail) row.appendChild(el('span', 'l-detail', entry.detail));
    return row;
  }

  function section(title) {
    var s = el('section', 'l-sec');
    s.appendChild(el('h3', null, title));
    return s;
  }

  function refreshLegend(W) {
    if (!legendEl) return;
    var body = legendEl.querySelector('.l-body');
    if (!body) return;
    body.innerHTML = '';

    if (!W || !W.player) {
      body.appendChild(el('p', 'p-note', 'キャラクターを選ぶと、ここに画面の説明が出る。'));
      return;
    }

    var data = Legend.compute(W);
    var i;

    // ヒントは中央下部のガイドへ分離した ([[D-82]])。ここは「今あるもの」だけ。

    // --- 見えているもの ---
    if (data.visible.monsters.length) {
      var ms = section('敵');
      for (i = 0; i < data.visible.monsters.length; i++) {
        ms.appendChild(glyphRow(data.visible.monsters[i]));
      }
      body.appendChild(ms);
    }
    if (data.visible.items.length) {
      var is = section('落ちているもの');
      for (i = 0; i < data.visible.items.length; i++) {
        is.appendChild(glyphRow(data.visible.items[i]));
      }
      body.appendChild(is);
    }
    if (data.visible.terrain.length) {
      var ts = section('地形');
      for (i = 0; i < data.visible.terrain.length; i++) {
        ts.appendChild(glyphRow(data.visible.terrain[i]));
      }
      body.appendChild(ts);
    }

    // --- 状態の意味 ---
    var ss = section('左の数字の意味');
    for (i = 0; i < data.status.length; i++) {
      var st = data.status[i];
      var row = el('div', 'l-row');
      var lab = el('span', 'l-stat', st.label + ' ' + st.value);
      if (st.color) lab.style.color = color(st.color);
      row.appendChild(lab);
      row.appendChild(el('span', 'l-detail', st.help));
      ss.appendChild(row);
    }
    body.appendChild(ss);
  }

  /* ---------- ガイド (中央下部・左) ---------- */

  function buildGuide() {
    guideEl.innerHTML = '';
    guideEl.appendChild(el('h2', 'p-title', 'いま何をすべきか'));
    guideEl.appendChild(el('div', 'g-body'));

    // 行動ボタンもキーと同じ経路へ ([[D-57]])
    guideEl.addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('.g-act') : null;
      if (!b || !b.dataset.cmd) return;
      dispatch(JSON.parse(b.dataset.cmd));
    });
  }

  function refreshGuide(W) {
    if (!guideEl) return;
    var body = guideEl.querySelector('.g-body');
    if (!body) return;
    body.innerHTML = '';

    if (!W || !W.player) {
      body.appendChild(el('p', 'p-note', '系統とロールを選ぶと、ここに次の一手が出る。'));
      return;
    }
    /* 押せる行動を先に。**助言を出しているのに押せない**のが元の問題だった
       ([[D-85]])。キーを併記して、使ううちに覚えてもらう。 */
    var acts = Action.list(W);
    for (var a = 0; a < acts.length; a++) {
      var act = acts[a];
      var b = el('button', 'g-act l-' + act.level);
      b.type = 'button';
      b.appendChild(el('span', 'g-key', act.key));
      b.appendChild(el('span', 'g-label', act.label));
      b.appendChild(el('span', 'g-why', act.why));
      b.dataset.cmd = JSON.stringify(act.cmd);
      body.appendChild(b);
    }

    var hints = Legend.hints(W);
    if (!acts.length && !hints.length) {
      body.appendChild(el('p', 'p-note', '今は急ぐことは無い。'));
      return;
    }
    for (var i = 0; i < hints.length; i++) {
      body.appendChild(el('p', 'g-hint l-' + hints[i].level, hints[i].text));
    }
  }

  /* ---------- メッセージ履歴 (中央下部・右) ---------- */

  var LOG_MAX = 40;

  function buildLog() {
    logEl.innerHTML = '';
    logEl.appendChild(el('h2', 'p-title', '記録'));
    logEl.appendChild(el('div', 'm-body'));
  }

  /**
   * 端末の上2行より長く遡れる。
   * **端末内のメッセージは消していない** ([[D-83]]) ―― 枠外を全部消しても
   * 何が起きたか分からなくならないようにするため。
   */
  function refreshLog(W) {
    if (!logEl) return;
    var body = logEl.querySelector('.m-body');
    if (!body) return;

    var msgs = (W && W.messages) || [];
    var from = Math.max(0, msgs.length - LOG_MAX);
    if (body.dataset.at === String(msgs.length)) return;   // 変化が無ければ触らない
    body.dataset.at = String(msgs.length);
    body.innerHTML = '';

    for (var i = from; i < msgs.length; i++) {
      var m = msgs[i];
      var row = el('div', 'm-row' + (i === msgs.length - 1 ? ' m-new' : ''));
      row.appendChild(el('span', 'm-text', m.text));
      if (m.count > 1) row.appendChild(el('span', 'm-count', ' x' + m.count));
      body.appendChild(row);
    }
    // 最新が見えるように下端へ
    logEl.scrollTop = logEl.scrollHeight;
  }

  /* ---------- 表示量の3段 ([[D-83]]) ---------- */

  var MODES = [
    { id: 'full', name: '全表示', cls: '' },
    { id: 'slim', name: '簡易', cls: 'ui-slim' },
    { id: 'bare', name: '非表示', cls: 'ui-bare' }
  ];
  var modeIndex = 0;

  function mode() { return MODES[modeIndex]; }

  /** 次の段へ回す。@returns {object} 新しい段 */
  function cycleMode(app, label) {
    modeIndex = (modeIndex + 1) % MODES.length;
    return applyMode(app, label);
  }

  function setMode(app, label, id) {
    for (var i = 0; i < MODES.length; i++) if (MODES[i].id === id) modeIndex = i;
    return applyMode(app, label);
  }

  function applyMode(app, label) {
    if (app) {
      for (var i = 0; i < MODES.length; i++) {
        if (MODES[i].cls) app.classList.remove(MODES[i].cls);
      }
      if (mode().cls) app.classList.add(mode().cls);
    }
    if (label) label.textContent = '表示 ' + mode().name + ' \\';
    return mode();
  }

  /* ---------- 公開 ---------- */

  /**
   * @param opts { commands, legend } DOM 要素
   * @param send コマンドを流す先 (boot.exec)
   */
  function init(opts, send) {
    cmdEl = opts.commands;
    legendEl = opts.legend;
    guideEl = opts.guide;
    logEl = opts.log;
    dispatch = send;
    if (cmdEl) buildCommands();
    if (legendEl) buildLegend();
    if (guideEl) buildGuide();
    if (logEl) buildLog();
  }

  /** 毎描画で呼ぶ。 */
  function refresh(W) {
    refreshCommands(W);
    refreshStrip(W);
    refreshLegend(W);
    refreshGuide(W);
    refreshLog(W);
  }

  return {
    init: init, refresh: refresh, GROUPS: GROUPS,
    MODES: MODES, mode: mode, cycleMode: cycleMode, setMode: setMode,
    LOG_MAX: LOG_MAX
  };
})();
