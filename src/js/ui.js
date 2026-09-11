/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
/* ui.js — 画面モード(所持品・装備・能力・店・知識・墓碑)。shell 層。
 *
 * ここは「グリフバッファに重ねて描く」だけ。ゲームの判断は cmd.js / hub.js にある。
 */
'use strict';

var UI = (function () {

  var mode = null;
  var context = null;     // 店 id など、モードごとの付随情報
  var LETTERS = 'abcdefghijklmnopqrstuvw';

  /* 一覧のカーソル ([[D-88]])。文字で直接選ぶのが速いが、
     「何をすべきか分からない」ときに開く一覧では、
     目で確かめてから決めたい。開くたびに先頭へ戻す。 */
  var cursor = 0;

  function open(m, ctx) { mode = m; context = ctx || null; cursor = 0; }
  function close() { mode = null; context = null; cursor = 0; }
  function cursorAt() { return cursor; }

  /** カーソルを動かす。端で止める(回り込ませない ―― 行き過ぎに気づけない)。 */
  function moveCursor(delta, count) {
    if (!count) return cursor;
    cursor = Math.max(0, Math.min(count - 1, cursor + delta));
    return cursor;
  }

  function setCursor(i, count) {
    cursor = Math.max(0, Math.min(Math.max(0, count - 1), i));
    return cursor;
  }
  function current() { return mode; }
  function ctx() { return context; }
  function isOpen() { return mode !== null; }

  function letterFor(i) { return LETTERS[i] || '?'; }

  /**
   * 幅 w のパネルを、マップ領域の中央に置くときの x。
   * 端末は画面に合わせて横に広がる ([[D-84]]) ので、
   * サイドバー基準で左詰めにすると広い画面で端に寄って見える。
   */
  function centerX(w) {
    var map = Render.MAP;
    return map.x + Math.max(0, Math.floor((map.w - w) / 2));
  }

  function indexOfLetter(ch) { return LETTERS.indexOf(ch); }

  /* --- 描画部品 --- */

  function panel(buf, x, y, w, h, title) {
    for (var yy = y; yy < y + h; yy++) {
      for (var xx = x; xx < x + w; xx++) Render.put(buf, xx, yy, ' ', 'white', 'dgray');
    }
    Render.text(buf, x + 1, y, ' ' + title + ' ', 'yellow', 'dgray', w - 2);
  }

  function lines(buf, x, y, w, arr, fg) {
    for (var i = 0; i < arr.length; i++) {
      Render.text(buf, x, y + i, arr[i], fg || 'white', 'dgray', w);
    }
  }

  /* --- 各モード --- */

  function drawList(buf, W, title, list, render, hint) {
    var h = Math.max(5, list.length + 4);
    var w = 54, x = centerX(54), y = 2;
    panel(buf, x, y, w, h, title);
    if (list.length === 0) Render.text(buf, x + 2, y + 2, '(なし)', 'gray', 'dgray', w - 4);
    for (var i = 0; i < list.length; i++) {
      var r = render(list[i], i);
      var on = i === cursor;
      // カーソル行は印を付ける。色だけに頼らない ([[D-52]])
      Render.text(buf, x + 1, y + 2 + i, on ? '>' : ' ', 'yellow', 'dgray', 1);
      Render.text(buf, x + 2, y + 2 + i, letterFor(i) + ') ' + r.text,
                  on ? 'yellow' : (r.color || 'white'), 'dgray', w - 4);
    }
    Render.text(buf, x + 2, y + h - 1,
                hint || '文字 / ↑↓ と Enter / ESC', 'gray', 'dgray', w - 4);
    return list;
  }

  function itemList(W, filter) {
    return W.inv.items.filter(filter || function () { return true; });
  }

  /**
   * ★一覧の内容はここだけが決める ([[D-51]])。
   * 描画(overlay)も選択(boot.handleSelect)も必ずこれを呼ぶので、
   * 「描いた順序と選んだ順序がズレる」ことが構造的に起きない。
   */
  function listFor(W, mode) {
    switch (mode) {
      case 'inventory':
      case 'drop':
        return W.inv.items.slice();
      case 'use':
        return itemList(W, function (it) { return !!it.effect; });
      case 'wear':
        return itemList(W, function (it) { return !!it.slot; });
      case 'equip':
        return Inventory.SLOTS.filter(function (s) { return Inventory.slotEnabled(W.player, s); });
      case 'ability':
        return W.player.abilities.map(function (id) { return Data.get().abilitiesById[id]; })
                 .filter(Boolean);
      case 'learn':
        return Ability.learnable(W.player);
      case 'shop':
        return ((W.shops && W.shops[context]) || []).slice();
      case 'sell': {
        var shop = Hub.shopById(context);
        return itemList(W, function (it) { return shop && shop.bases.indexOf(it.base) !== -1; });
      }
      case 'home':
        return W.home.slice();
      case 'store':
        return W.inv.items.slice();
      case 'lore':
        return loreIds(W);
      case 'site':
        return Site.all();
      case 'net':
        return Net.ops();
      case 'display':
        return displayRows();
      case 'act':
        return Action.list(W);
      case 'salvage':
        return W.inv.items.filter(function (it) { return !Craft.salvageReason(W, it); });
      case 'graft':
        return W.inv.items.filter(function (it) { return it.slot && it.known && !it.uniqueId; });
      case 'module':
        return Craft.moduleList(W).map(function (m) { return { id: m.sigil, count: m.count }; });
      // 作成画面は世界が存在する前に呼ばれるので W を参照しない
      case 'lineage':
        return Data.get().lineages.slice();
      case 'role':
        return Data.get().roles.slice();
      default:
        return [];
    }
  }

  /** 知識一覧の並び。深度順。 */
  function loreIds(W) {
    var ids = Object.keys(W.lore).filter(function (id) { return W.lore[id].seen > 0; });
    ids.sort(function (a, b) {
      var ma = Data.get().monstersById[a], mb = Data.get().monstersById[b];
      return (ma ? ma.depth : 0) - (mb ? mb.depth : 0);
    });
    return ids;
  }

  /**
   * 一覧の1行。**色は文字が伝える以上のことを漏らさない** ([[D-52]] [[D-78]])。
   * 未解析の改修品を色で青くしていたので、名前が「未解析の〜」でも
   * 一覧を見れば当たりだと分かってしまい、刻印式鑑定([[D-06]])が骨抜きになっていた。
   * 併せて未解析には `?` を付ける ―― 色だけに情報を載せない。
   */
  function itemRow(W) {
    return function (it) {
      var known = !it.slot || Sigil.fullyKnown(W.knowledge, it);
      var text = Inventory.label(it, W.knowledge);
      var color = 'white';
      if (!known) { color = 'lgray'; text += ' ?'; }
      else if (it.tainted) color = 'magenta';
      else if (it.uniqueId) color = 'yellow';
      else if (it.egoId) color = 'cyan';
      return { text: text, color: color };
    };
  }

  function drawEquip(buf, W) {
    var slots = listFor(W, 'equip');
    var w = 54, x = centerX(54), y = 2, h = slots.length + 6;
    panel(buf, x, y, w, h, '装備');
    for (var i = 0; i < slots.length; i++) {
      var s = slots[i];
      var it = W.inv.equip[s];
      var text = letterFor(i) + ') ' + Inventory.SLOT_NAME[s] + ': ' +
                 (it ? Inventory.label(it, W.knowledge) : '—');
      Render.text(buf, x + 2, y + 2 + i, text, it ? 'white' : 'gray', 'dgray', w - 4);
    }
    var b = W.player.equipBonus || {};
    Render.text(buf, x + 2, y + h - 3,
      'AC ' + Inventory.totalAC(W.inv) + '  気密 ' + (W.player.seal || 0) +
      '  速度 ' + Turn.speedLabel(W.player.speed), 'cyan', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 2,
      '重量 ' + Inventory.totalWeight(W.inv) + '/' + Inventory.capacity(W.player) +
      '  耐性 ' + (Object.keys(b.resist || {}).join(',') || 'なし'), 'cyan', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で外す / ESC', 'gray', 'dgray', w - 4);
    return slots;
  }

  function drawAbilities(buf, W) {
    var p = W.player;
    if (!p.system) {
      var w0 = 40, x0 = centerX(40), y0 = 4;
      panel(buf, x0, y0, w0, 5, '能力');
      Render.text(buf, x0 + 2, y0 + 2, this && '', 'white', 'dgray', w0 - 4);
      Render.text(buf, x0 + 2, y0 + 2, p.roleName + 'は能力を持たない。', 'gray', 'dgray', w0 - 4);
      Render.text(buf, x0 + 2, y0 + 4, 'ESC で閉じる', 'gray', 'dgray', w0 - 4);
      return [];
    }
    var known = listFor(W, 'ability');
    var w = 58, x = centerX(58), y = 2, h = known.length + 6;
    panel(buf, x, y, w, h, Ability.SYSTEM_LABEL[p.system] + '  ' +
          Ability.SYSTEM_NAME[p.system] + ' ' + p.sp + '/' + p.spMax);
    for (var i = 0; i < known.length; i++) {
      var a = known[i];
      var fail = Ability.failRate(p, a);
      var txt = letterFor(i) + ') ' + a.name +
                '  ' + Ability.SYSTEM_NAME[p.system] + a.cost +
                '  失敗 ' + fail + '%';
      Render.text(buf, x + 2, y + 2 + i, txt,
                  p.sp >= a.cost ? 'white' : 'gray', 'dgray', w - 4);
    }
    if (known.length === 0) Render.text(buf, x + 2, y + 2, '(まだ何も習得していない)', 'gray', 'dgray', w - 4);
    var canLearn = Ability.learnable(p).length > 0 && Ability.canLearnMore(p);
    Render.text(buf, x + 2, y + h - 2,
      canLearn ? '習得できる能力がある (G)' : '習得枠 ' + p.abilities.length + '/' + Ability.learnableCount(p),
      canLearn ? 'yellow' : 'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で使用 / G で習得 / ESC', 'gray', 'dgray', w - 4);
    return known;
  }

  function drawLearn(buf, W) {
    var list = listFor(W, 'learn');
    return drawList(buf, W, '習得', list, function (a) {
      return { text: a.name + '  Lv' + a.level + '  ' + (a.desc || '') };
    }, '文字で習得 / ESC');
  }

  function drawShop(buf, W) {
    var shop = Hub.shopById(context);
    var stock = listFor(W, 'shop');
    var w = 62, x = centerX(62), y = 1, h = stock.length + 6;
    panel(buf, x, y, w, h, shop.name + '   所持 ' + W.inv.credits + ' cr');
    for (var i = 0; i < stock.length; i++) {
      var it = stock[i];
      var price = Hub.buyPrice(W, it);
      var afford = W.inv.credits >= price;
      Render.text(buf, x + 2, y + 2 + i,
        letterFor(i) + ') ' + Inventory.label(it, W.knowledge), afford ? 'white' : 'gray', 'dgray', w - 14);
      Render.text(buf, x + w - 11, y + 2 + i, String(price) + ' cr', afford ? 'yellow' : 'gray', 'dgray', 10);
    }
    if (stock.length === 0) Render.text(buf, x + 2, y + 2, '(在庫切れ)', 'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 2, '文字で購入 / s で売却 / ESC', 'gray', 'dgray', w - 4);
    if (shop.services) {
      Render.text(buf, x + 2, y + h - 1,
        shop.services.indexOf('analyze') !== -1 ? 'A) 解析 120cr〜   C) 治療 200cr' :
        (shop.services.indexOf('repair') !== -1
          ? 'R) 修理 40cr/点   B) 解体   G) 移植 (パーツ ' + Craft.parts(W) + ')' : ''),
        'cyan', 'dgray', w - 4);
    }
    return stock;
  }

  function drawSell(buf, W) {
    var shop = Hub.shopById(context);
    var list = listFor(W, 'sell');
    return drawList(buf, W, '売却  (' + shop.name + ')', list, function (it) {
      return { text: Inventory.label(it, W.knowledge) + '   ' + Hub.sellPrice(W, it) + ' cr' };
    }, '文字で売却 / ESC');
  }

  function drawHome(buf, W) {
    return drawList(buf, W, '格納庫  ' + W.home.length + '/' + Hub.HOME_MAX, W.home, function (it) {
      return { text: Inventory.label(it, W.knowledge) };
    }, '文字で取り出す / s で預ける / ESC');
  }

  function drawStore(buf, W) {
    return drawList(buf, W, '預ける', W.inv.items, itemRow(W), '文字で預ける / ESC');
  }

  /** 敵の知識 (monster memory)。 */
  function drawLore(buf, W) {
    var ids = listFor(W, 'lore');
    if (context && W.lore[context]) {
      var text = Lore.describe(W, context) || [];
      var w = 58, x = centerX(58), y = 2;
      panel(buf, x, y, w, text.length + 4, '知識');
      lines(buf, x + 2, y + 2, w - 4, text);
      Render.text(buf, x + 2, y + text.length + 3, 'ESC で戻る', 'gray', 'dgray', w - 4);
      return null;
    }
    return drawList(buf, W, '遭遇した敵  ' + ids.length + ' 種', ids, function (id) {
      var m = Data.get().monstersById[id];
      var e = W.lore[id];
      return { text: (m ? m.name : id) + '   深度' + (m ? m.depth : '?') +
                     '   撃破 ' + e.kills, color: e.kills > 0 ? 'white' : 'gray' };
    }, '文字で詳細 / ESC');
  }

  function drawChar(buf, W) {
    var p = W.player;
    var w = 52, x = centerX(52), y = 2;
    var b = p.equipBonus || {};
    var body = [
      '',
      '  ' + p.lineageName + ' / ' + p.roleName,
      '',
      '  レベル ' + p.level + '    経験値 ' + p.exp + ' / ' + Player.expNeeded(p.level, p.expFactor),
      '  HP ' + p.hp + '/' + p.hpMax + (p.system ? ('    ' + Ability.SYSTEM_NAME[p.system] + ' ' + p.sp + '/' + p.spMax) : ''),
      '',
      '  体力 ' + Stat.label(Stat.effective(p, 'str')) + '    演算 ' + Stat.label(Stat.effective(p, 'int')),
      '  意志 ' + Stat.label(Stat.effective(p, 'wis')) + '    反射 ' + Stat.label(Stat.effective(p, 'dex')),
      '  耐久 ' + Stat.label(Stat.effective(p, 'con')) + '    統率 ' + Stat.label(Stat.effective(p, 'chr')),
      '',
      '  AC ' + p.ac + '   気密 ' + (p.seal || 0) + '   速度 ' + Turn.speedLabel(Turn.effectiveSpeed(p)),
      '  攻撃回数 ' + Combat.blowsFor(p, Inventory.weapon(W.inv)),
      '',
      '  技能  近接 ' + p.skills.melee + '  射撃 ' + p.skills.shoot +
        '  隠密 ' + p.skills.stealth + '  知覚 ' + p.skills.perception + '  解錠 ' + p.skills.disarm,
      '',
      '  耐性  ' + (Object.keys(b.resist || {}).join(', ') || 'なし'),
      '  到達最深度 ' + p.depthMax + '   被曝 ' + (p.exposure || 0),
      '  《適合》 ' + adaptationLine(W),
      '',
      '  ESC で閉じる'
    ];
    panel(buf, x, y, w, body.length + 1, 'キャラクター');
    lines(buf, x, y + 1, w, body);
  }

  /**
   * 注視モード。カーソル下の説明を出す (docs/09 §9.4)。
   * サイドバーがあるならその下部に、無い(携帯)なら最下段に横並びで置く ([[D-87]])。
   */
  function drawLook(buf, W) {
    var what = Target.at(W, W.cursor.x, W.cursor.y);
    var lines = Target.describe(W, what);
    var hint = '. 歩く / Tab 次 / t 目標';

    if (!Render.hasSidebar()) {
      // 携帯: 最下段の2行に収める。マップを潰さない
      var y0 = Render.TERM.h - 2;
      Render.text(buf, 0, y0, lines.join('  '), 'cyan', 'black', Render.TERM.w);
      Render.text(buf, 0, y0 + 1, hint, 'gray', 'black', Render.TERM.w);
      return null;
    }

    var y = Render.TERM.h - lines.length - 3;
    var w = Render.SIDEBAR_W - 1;
    for (var i = 0; i < lines.length; i++) {
      Render.text(buf, 0, y + i, lines[i], i === 0 ? 'cyan' : 'white', 'black', w);
    }
    Render.text(buf, 0, Render.TERM.h - 3, '. そこへ歩く', 'gray', 'black', w);
    Render.text(buf, 0, Render.TERM.h - 2, 'Tab 次', 'gray', 'black', w);
    Render.text(buf, 0, Render.TERM.h - 1, 't 目標', 'gray', 'black', w);
    return null;
  }

  /** メッセージ履歴 (docs/09 §9.3)。 */
  function drawLog(buf, W) {
    var h = 30, w = 62, x = centerX(62), y = 2;
    panel(buf, x, y, w, h, 'メッセージ履歴');
    var list = W.messages.slice(-(h - 3));
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      Render.text(buf, x + 2, y + 2 + i,
        m.text + (m.count > 1 ? ' (x' + m.count + ')' : ''),
        i === list.length - 1 ? 'white' : 'gray', 'dgray', w - 4);
    }
    Render.text(buf, x + 2, y + h - 1, 'ESC で閉じる', 'gray', 'dgray', w - 4);
    return null;
  }

  /** キャラクター作成 (docs/09 §9.7)。 */
  function drawCreate(buf, W, mode, draft) {
    var list = listFor(W, mode);
    var w = 62, x = centerX(62), y = 2;
    var h = Math.max(list.length + 8, 20);
    panel(buf, x, y, w, h, mode === 'lineage' ? '系統を選ぶ' : 'ロールを選ぶ');

    for (var i = 0; i < list.length; i++) {
      Render.text(buf, x + 2, y + 2 + i, letterFor(i) + ') ' + list[i].name,
                  'white', 'dgray', 22);
    }
    // 選択中の説明とプレビュー
    var sel = list[draft.hover] || list[0];
    if (sel) {
      Render.text(buf, x + 26, y + 2, sel.name, 'yellow', 'dgray', w - 28);
      wrap(buf, x + 26, y + 4, w - 28, 6, sel.desc || '', 'white');
      var preview = previewOf(W, mode, draft, sel);
      for (var j = 0; j < preview.length; j++) {
        Render.text(buf, x + 26, y + 10 + j, preview[j], 'cyan', 'dgray', w - 28);
      }
    }
    Render.text(buf, x + 2, y + h - 1,
      '文字で選択 / 方向キーで移動 / * ランダム', 'gray', 'dgray', w - 4);
    return list;
  }

  /**
   * プレビュー。固定配分なので事前に見せられる ([[D-41]])。
   * 系統だけ選んだ段階では**その系統の素の値**を、
   * ロールまで決まったら**実際に作られるキャラクター**を出す。
   */
  function previewOf(W, mode, draft, sel) {
    var linId = mode === 'lineage' ? sel.id : draft.lineage;
    var roleId = mode === 'role' ? sel.id : draft.role;

    // 系統だけ: 補正そのものを見せる(ロールが決まらないと能力値は確定しない)
    if (linId && !roleId) {
      var lin = Data.get().lineagesById[linId];
      if (!lin) return [];
      // 1行に6つ並べると全角で幅を超えるので3つずつ2行に割る
      var fmt = function (k) {
        var v = lin.stats[k] || 0;
        return Effect.STAT_NAME[k] + (v > 0 ? '+' : (v < 0 ? '' : '±')) + v;
      };
      var out = [
        '能力値補正',
        '  ' + ['str', 'int', 'wis'].map(fmt).join('  '),
        '  ' + ['dex', 'con', 'chr'].map(fmt).join('  '),
        '',
        'ヒットダイス ' + lin.hitDie,
        '経験値倍率 ' + lin.expFactor + '%'
      ];
      if (lin.infra) out.push('暗視 ' + lin.infra);
      if ((lin.flags || []).length) out.push('特性 ' + lin.flags.join(' '));
      return out;
    }

    if (!linId || !roleId) return [];
    try {
      var p = Player.create('preview/' + linId + '/' + roleId, linId, roleId);
      return [
        'HP ' + p.hpMax + (p.system ? ('   ' + Ability.SYSTEM_NAME[p.system] + ' ' + p.spMax) : ''),
        '',
        '体力 ' + Stat.label(Stat.effective(p, 'str')) + '   演算 ' + Stat.label(Stat.effective(p, 'int')),
        '意志 ' + Stat.label(Stat.effective(p, 'wis')) + '   反射 ' + Stat.label(Stat.effective(p, 'dex')),
        '耐久 ' + Stat.label(Stat.effective(p, 'con')) + '   統率 ' + Stat.label(Stat.effective(p, 'chr')),
        '',
        '経験値倍率 ' + p.expFactor + '%'
      ];
    } catch (e) { return []; }
  }

  /** 単純な折り返し表示。 */
  function wrap(buf, x, y, w, maxLines, str, fg) {
    var chars = Array.from(String(str));
    var line = '', col = 0, row = 0;
    for (var i = 0; i < chars.length && row < maxLines; i++) {
      var cw = Render.isWide(chars[i]) ? 2 : 1;
      if (col + cw > w) { Render.text(buf, x, y + row, line, fg, 'dgray', w); row++; line = ''; col = 0; }
      line += chars[i]; col += cw;
    }
    if (line && row < maxLines) Render.text(buf, x, y + row, line, fg, 'dgray', w);
  }

  /**
   * 星系マップ ― 降下先を選ぶ (docs/08 §8.2)。
   * サイトごとの到達最深度と《適合》の取得状況を一覧にする。
   */
  function drawSite(buf, W) {
    var list = listFor(W, 'site');
    var w = 62, x = centerX(62), y = 2;
    var h = list.length * 2 + 7;
    panel(buf, x, y, w, h, '降下先を選ぶ   《適合》 ' + Site.adaptationCount(W) + '/4');

    for (var i = 0; i < list.length; i++) {
      var s = Site.summary(W, list[i]);
      var row = y + 2 + i * 2;
      var head = letterFor(i) + ') ' + s.name;
      var color = s.locked ? 'gray' : (s.cleared ? 'cyan' : 'white');
      /* 現在地の印は**文字の代わりではなく左の余白**に置く。
         文字を消すと選べないように見えるが、実際には選べてしまう。 */
      if (W.site && W.site.id === s.id) {
        Render.text(buf, x + 1, row, '>', 'yellow', 'dgray', 1);
      }
      Render.text(buf, x + 2, row, head, color, 'dgray', 26);

      /* 端末は80桁しかない。列幅を足すと必ずどこかが切れるので、
         「深度 / 到達 / 適合」の3つだけに絞って詰める。 */
      var info = '深度 ' + s.range +
                 '  到達 ' + (s.reached || '—') +
                 (s.cleared ? '  《' + s.adaptation + '》' : '');
      Render.text(buf, x + 28, row, info, s.cleared ? 'cyan' : 'gray', 'dgray', w - 29);

      var note = s.locked || s.desc;
      Render.text(buf, x + 5, row + 1, note, s.locked ? 'red' : 'dgray', 'dgray', w - 6);
    }

    Render.text(buf, x + 2, y + h - 3,
      '選んだ場所の到達最深部から再開する。初回は最浅部から。',
      'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 2,
      '最深部のユニークが《適合》を落とす。4つ揃うと《起源》へ。',
      'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で選択 / ESC', 'gray', 'dgray', w - 4);
    return list;
  }

  /** 取得済みの《適合》を並べる。 */
  function adaptationLine(W) {
    if (typeof Site === 'undefined') return '—';
    var got = [];
    for (var k in Site.ADAPTATION_NAME) {
      if (Site.hasAdaptation(W, k)) got.push(Site.ADAPTATION_NAME[k]);
    }
    return got.length ? got.join(' ') + '  (' + got.length + '/4)' : '—  (0/4)';
  }

  /**
   * 勝利画面 (docs/09 §9.14)。墓碑と同じ枠を使い、中身を差し替える。
   * 収集した断片の数で結末の解像度が変わる ([[doc:endgame]] §7.8)。
   */
  function drawVictory(buf, W) {
    var g = W.grave || {};
    var end = g.ending || [];
    var w = 62, x = centerX(62), y = 1;
    var h = 11 + end.length * 4;
    panel(buf, x, y, w, h, '《起源》 は停止した。');

    var pct = Math.round((g.loreRatio || 0) * 100);
    var head = [
      '',
      '  ' + (g.lineage || '') + ' / ' + (g.role || '') + '   レベル ' + (g.level || 0),
      '  到達深度 ' + (g.depthMax || 0) + '   ターン ' + (g.turn || 0) +
        '   撃破ユニーク ' + (g.uniquesKilled || 0),
      '  収集ログ断片 ' + (g.loreFound || 0) + '/' + (g.loreTotal || 0) + ' (' + pct + '%)',
      ''
    ];
    var row = y + 1;
    for (var i = 0; i < head.length; i++) {
      Render.text(buf, x + 1, row++, head[i], 'cyan', 'dgray', w - 2);
    }

    if (!end.length) {
      Render.text(buf, x + 3, row++,
        '断片が足りない。何が終わったのかは分からないままだ。', 'gray', 'dgray', w - 4);
    }
    for (var e = 0; e < end.length; e++) {
      Render.text(buf, x + 3, row++, '―― ' + end[e].title + ' ――', 'yellow', 'dgray', w - 4);
      var lines = wrap(end[e].text, w - 6);
      for (var l = 0; l < lines.length && l < 3; l++) {
        Render.text(buf, x + 3, row++, lines[l], 'white', 'dgray', w - 4);
      }
    }

    row = y + h - 2;
    if (g.devRun) {
      Render.text(buf, x + 1, row++, '  開発モード ―― 記録しない', 'red', 'dgray', w - 2);
    }
    Render.text(buf, x + 1, row, '  N で新しいランを始める', 'gray', 'dgray', w - 2);
  }

  /** 全角を2セルとして数え、幅で折る。 */
  function wrap(text, width) {
    var out = [], line = '', wsum = 0;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      var cw = Render.isWide(ch) ? 2 : 1;
      if (wsum + cw > width) { out.push(line); line = ''; wsum = 0; }
      line += ch; wsum += cw;
    }
    if (line) out.push(line);
    return out;
  }

  /**
   * 電脳層 ― 端末に接続する (docs/11 §11.3)。
   * **成功率と代償を先に見せる。** 賭けであることを隠さない。
   */
  function drawNet(buf, W) {
    var list = Net.listFor(W);
    var w = 60, x = centerX(60), y = 2;
    var h = list.length * 2 + 7;
    var p = W.player;
    panel(buf, x, y, w, h, '接続   認知 ' + p.cog + '/' + p.cogMax +
                           '   接続技能 ' + (p.skills.net || 0));

    for (var i = 0; i < list.length; i++) {
      var e = list[i], op = e.op, row = y + 2 + i * 2;
      var usable = !e.blocked && p.cog >= op.cost;
      Render.text(buf, x + 2, row, letterFor(i) + ') ' + op.name,
                  usable ? 'white' : 'gray', 'dgray', 22);

      // 端末は80桁に収まらないので、列は「代償・成否・難度」の3つだけに絞る
      var info = e.blocked ? e.blocked
        : '認知 ' + op.cost + '/+' + op.fail + '   成功 ' +
          Net.chance(W, op) + '%   ICE ' + Net.difficulty(W, op);
      Render.text(buf, x + 25, row, info,
                  e.blocked ? 'gray' : (usable ? 'cyan' : 'red'), 'dgray', w - 26);
      Render.text(buf, x + 4, row + 1, op.desc, 'dgray', 'dgray', w - 5);
    }

    Render.text(buf, x + 2, y + h - 3,
      '失敗しても操作は起きない。認知だけが持っていかれる。', 'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 2,
      '認知が尽きると昏倒する。ここは安全な場所ではない。', 'red', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で選択 / ESC', 'gray', 'dgray', w - 4);
    return list;
  }

  /* ---------- 文脈アクション (docs/09 §9.18) ---------- */

  /**
   * 今ここでできること。**キーを併記する** ―― 松葉杖ではなく教材にするため。
   * 使ううちにキーを覚えて、この一覧を開かなくなるのが正しい姿 ([[D-85]])。
   */
  function drawActions(buf, W) {
    var acts = Action.list(W);
    var w = 56, x = centerX(56), y = 3;
    var h = Math.max(6, acts.length * 2 + 5);
    panel(buf, x, y, w, h, '今できること');

    if (!acts.length) {
      Render.text(buf, x + 2, y + 2, '今すぐすべきことは無い。歩いて探すこと。',
                  'gray', 'dgray', w - 4);
    }
    var LEVEL_COLOR = { danger: 'red', warn: 'yellow', tip: 'cyan', info: 'white' };
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i], row = y + 2 + i * 2;
      var on = i === cursor;
      Render.text(buf, x + 1, row, on ? '>' : ' ', 'yellow', 'dgray', 1);
      Render.text(buf, x + 2, row, letterFor(i) + ')', on ? 'yellow' : 'gray', 'dgray', 3);
      Render.text(buf, x + 6, row, a.key, 'yellow', 'dgray', 6);
      Render.text(buf, x + 13, row, a.label,
                  on ? 'yellow' : (LEVEL_COLOR[a.level] || 'white'), 'dgray', w - 15);
      Render.text(buf, x + 13, row + 1, a.why, 'dgray', 'dgray', w - 15);
    }
    Render.text(buf, x + 2, y + h - 2, 'a) の隣がキー。覚えたら一覧を開かずに押せる。',
                'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字 / ↑↓ と Enter / ESC', 'gray', 'dgray', w - 4);
    return acts;
  }

  /* ---------- 表示設定 (docs/09 §9.9) ---------- */

  /** 配色と文字サイズを1つの一覧にまとめる。行の順序が選択の順序になる。 */
  function displayRows() {
    if (typeof Theme === 'undefined') return [];
    var rows = [];
    var pals = Theme.palettes();
    for (var i = 0; i < pals.length; i++) {
      rows.push({ kind: 'palette', id: pals[i].id, name: pals[i].name, desc: pals[i].desc });
    }
    var sc = Theme.scales();
    for (var j = 0; j < sc.length; j++) {
      rows.push({ kind: 'scale', id: sc[j].id, name: '枠外UI の文字: ' + sc[j].name, desc: '' });
    }
    return rows;
  }

  function drawDisplay(buf, W) {
    var rows = displayRows();
    var cur = typeof Theme !== 'undefined' ? Theme.current() : { palette: '', scale: '' };
    var w = 60, x = centerX(60), y = 3, h = rows.length + 7;
    panel(buf, x, y, w, h, '表示設定');

    var row = y + 1;
    Render.text(buf, x + 2, row++, '配色', 'cyan', 'dgray', w - 4);
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'scale' && (i === 0 || rows[i - 1].kind === 'palette')) {
        Render.text(buf, x + 2, row++, '文字サイズ', 'cyan', 'dgray', w - 4);
      }
      var on = cur[r.kind] === r.id;
      Render.text(buf, x + 2, row, (on ? '> ' : '  ') + letterFor(i) + ') ' + r.name,
                  on ? 'yellow' : 'white', 'dgray', 26);
      if (r.desc) Render.text(buf, x + 27, row, r.desc, 'gray', 'dgray', w - 29);
      row++;
    }
    Render.text(buf, x + 2, y + h - 2,
      '色だけに情報は載せていない。数値と記号でも読める。',
      'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で選択 / ESC', 'gray', 'dgray', w - 4);
    return rows;
  }

  /* ---------- 工房: 解体と移植 (docs/11 §11.4) ---------- */

  function drawSalvage(buf, W) {
    var list = listFor(W, 'salvage');
    var w = 58, x = centerX(58), y = 3;
    var h = Math.max(6, list.length + 6);
    panel(buf, x, y, w, h, '解体する   ―― 改修品からモジュールを取り出す');

    if (!list.length) {
      Render.text(buf, x + 2, y + 2,
        '解体できるものが無い。改修品(エゴ)でないと何も残らない。',
        'gray', 'dgray', w - 4);
    }
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      Render.text(buf, x + 2, y + 2 + i,
        letterFor(i) + ') ' + Sigil.name(W.knowledge, it), 'white', 'dgray', 32);
      Render.text(buf, x + 35, y + 2 + i,
        '→ 《' + Craft.sigilLabel(Craft.salvageYield(it)) + '》', 'cyan', 'dgray', w - 37);
    }
    Render.text(buf, x + 2, y + h - 2, '解体した装備は戻らない。', 'red', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で選択 / ESC', 'gray', 'dgray', w - 4);
    return list;
  }

  function drawModules(buf, W) {
    var list = Craft.moduleList(W);
    var w = 52, x = centerX(52), y = 3;
    var h = Math.max(6, list.length + 6);
    panel(buf, x, y, w, h, '移植するモジュール   レアパーツ ' + Craft.parts(W));

    if (!list.length) {
      Render.text(buf, x + 2, y + 2, 'モジュールを持っていない。まず解体すること。',
                  'gray', 'dgray', w - 4);
    }
    for (var i = 0; i < list.length; i++) {
      Render.text(buf, x + 2, y + 2 + i,
        letterFor(i) + ') 《' + Craft.sigilLabel(list[i].sigil) + '》 x' + list[i].count,
        'cyan', 'dgray', w - 4);
    }
    Render.text(buf, x + 2, y + h - 1, '文字で選択 / ESC', 'gray', 'dgray', w - 4);
    return list.map(function (m) { return { id: m.sigil, count: m.count }; });
  }

  function drawGraft(buf, W) {
    var list = listFor(W, 'graft');
    var sig = UI.ctx();
    var w = 58, x = centerX(58), y = 3;
    var h = Math.max(6, list.length + 6);
    panel(buf, x, y, w, h,
          '《' + Craft.sigilLabel(sig) + '》をどれに移植するか');

    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var why = Craft.transplantReason(W, it, sig);
      Render.text(buf, x + 2, y + 2 + i,
        letterFor(i) + ') ' + Sigil.name(W.knowledge, it),
        why ? 'gray' : 'white', 'dgray', 30);
      Render.text(buf, x + 33, y + 2 + i,
        why || ('枠 ' + Craft.grafted(it) + '/' + Craft.MAX_MODULES +
                '   パーツ ' + Craft.partsNeeded(W, it)),
        why ? 'red' : 'cyan', 'dgray', w - 35);
    }
    Render.text(buf, x + 2, y + h - 2, '移植は失敗しない。枠は2つまで。', 'gray', 'dgray', w - 4);
    Render.text(buf, x + 2, y + h - 1, '文字で選択 / ESC', 'gray', 'dgray', w - 4);
    return list;
  }

  function drawGrave(buf, W) {
    if (W.won) return drawVictory(buf, W);
    var g = W.grave || {};
    var w = 48, x = centerX(48), y = 5, h = 14;
    panel(buf, x, y, w, h, '墓碑');
    var body = [
      '',
      '  ' + (g.lineage || '') + ' / ' + (g.role || ''),
      '',
      '  レベル ' + (g.level || 0) + '   経験値 ' + (g.exp || 0),
      '  到達深度 ' + (g.depthMax || 0) + '   死亡深度 ' + (g.depth || 0),
      '  クレジット ' + (g.credits || 0),
      '  ターン ' + (g.turn || 0),
      '  seed ' + (g.seed || ''),
      '',
      '  死因: ' + (g.cause || '不明'),
      '',
      '  N で新しいランを始める'
    ];
    for (var i = 0; i < body.length && i < h - 1; i++) {
      Render.text(buf, x + 1, y + 1 + i, body[i], i === 9 ? 'red' : 'white', 'dgray', w - 2);
    }
  }

  function drawHelp(buf) {
    var body = [
      '移動        hjklyubn / テンキー / 矢印     待機 . s 5',
      '連続移動    Shift + 方向        休息  R',
      '降下/上昇   > / <               拾う  g ,',
      '降下先を選ぶ V     (母船でのみ)',
      '接続        J     (端末 Ω の上でのみ)',
      '表示設定    =     (配色・文字サイズ)',
      'パネルの量  \\\\     (全表示 / 簡易 / 非表示)',
      '今できること Space (文脈に合う行動の一覧)',
      '一覧の選択  文字 / ↑↓ と Enter',
      '',
      '注視/目標   x     (Tab 次へ / t 目標指定 / . そこへ歩く)',
      '撃つ        f     能力  m     ライト  L',
      '',
      '所持品 i    使う u    装備 w    装備一覧 e    置く d',
      'キャラ C    知識 M    履歴 ^P   店に入る Enter',
      '',
      'セーブ S    ロード ^L    新シード N    再生成 ^R',
      '',
      '',
      'STRATA — GNU GPL v2。Angband の機構を継承している。',
      '由来と帰属は NOTICE.md、条文は LICENSE。',
      '',
      'ESC で閉じる'
    ];
    var w = 56, x = centerX(56), y = 3, h = body.length + 3;
    panel(buf, x, y, w, h, '操作');
    lines(buf, x + 2, y + 2, w - 4, body);
  }

  /**
   * グリフバッファに現在のモードを重ねる。戻り値は選択対象のリスト。
   * 一覧は必ず listFor() から取る ([[D-51]])。
   */
  function overlay(buf, W, draft) {
    switch (mode) {
      case 'inventory': return drawList(buf, W, '所持品', listFor(W, mode), itemRow(W));
      case 'use':  return drawList(buf, W, '使う', listFor(W, mode), itemRow(W), '文字で使用 / ESC');
      case 'wear': return drawList(buf, W, '装備する', listFor(W, mode), itemRow(W), '文字で装備 / ESC');
      case 'drop': return drawList(buf, W, '置く', listFor(W, mode), itemRow(W), '文字で選択 / ESC');
      case 'equip': return drawEquip(buf, W);
      case 'ability': return drawAbilities(buf, W);
      case 'learn': return drawLearn(buf, W);
      case 'shop': return drawShop(buf, W);
      case 'sell': return drawSell(buf, W);
      case 'home': return drawHome(buf, W);
      case 'store': return drawStore(buf, W);
      case 'lore': return drawLore(buf, W);
      case 'site': return drawSite(buf, W);
      case 'net': return drawNet(buf, W);
      case 'display': return drawDisplay(buf, W);
      case 'act': return drawActions(buf, W);
      case 'salvage': return drawSalvage(buf, W);
      case 'graft': return drawGraft(buf, W);
      case 'module': return drawModules(buf, W);
      case 'look': return drawLook(buf, W);
      case 'log': return drawLog(buf, W);
      case 'lineage':
      case 'role': return drawCreate(buf, W, mode, draft || { hover: 0 });  // W は null でもよい
      case 'char': drawChar(buf, W); return null;
      case 'grave': drawGrave(buf, W); return null;
      case 'help': drawHelp(buf); return null;
      default: return null;
    }
  }

  return {
    open: open, close: close, current: current, ctx: ctx, isOpen: isOpen,
    cursorAt: cursorAt, moveCursor: moveCursor, setCursor: setCursor,
    letterFor: letterFor, indexOfLetter: indexOfLetter,
    itemList: itemList, listFor: listFor, itemRow: itemRow,
    displayRows: displayRows, loreIds: loreIds, overlay: overlay,
    adaptationLine: adaptationLine, drawVictory: drawVictory, wrap: wrap
  };
})();
