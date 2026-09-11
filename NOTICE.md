# NOTICE — 帰属表示と由来

Copyright (C) 2026 istintone

STRATA (codename: `xangband`) は **GNU General Public License, version 2** で配布する。
全文は [LICENSE](LICENSE)。

このファイルは「**何がどこから来たか**」を記録する。
ライセンスの条文ではなく、経緯の記録として読めるように書いてある。

---

## 1. Angband

STRATA は **Angband の機構を継承して設計されている**。
そのことは隠していない ―― [README](README.md) にも
[docs/00-concept.md](docs/00-concept.md) にも最初から書いてある。

Angband は **GNU GPL version 2**(および Angband 独自ライセンス)で配布されている。
<https://github.com/angband/angband>

### 1.1 本家から数値表を写している箇所

**これがこのプロジェクトが GPL v2 を選んだ理由。**
機構やルールそのものは著作物ではないが、**数値表は表現**なので、
写した以上は由来を明記し、ライセンスを継承する。

| このプロジェクト | Angband の対応物 | 状態 |
|---|---|---|
| `Player.EXP_TABLE` ([src/js/player.js](src/js/player.js)) | `player_exp[]` | 50要素とも同一 |
| `Stat.DAM` ([src/js/stat.js](src/js/stat.js)) | `adj_str_td` | 同一 |
| `Stat.HIT` ([src/js/stat.js](src/js/stat.js)) | `adj_dex_th` | 同一 |
| `Stat.HP` ([src/js/stat.js](src/js/stat.js)) | `adj_con_mhp` | 同一 |
| `Turn.ENERGY_TABLE` ([src/js/turn.js](src/js/turn.js)) | `extract_energy[]` | 本家表からの再構成 |

### 1.2 構造だけを踏襲している箇所 (コードは独自)

式や手順であって、写した表ではない。C から JavaScript への移植でもなく、
仕様([docs/02-core-rules.md](docs/02-core-rules.md))から書き起こしている。

- 命中判定 `test_hit()` の構造 ([[doc:core]] §2.6)
- エネルギー式ターンスケジューラ ([[doc:core]] §2.1)
- 出現テーブルの `1/rarity` 重みと深度窓 ([[doc:core]] §2.4)
- 敵の遠隔攻撃頻度 `spell_freq` (1_IN_X) ([[doc:core]] §2.9.1)
- 状態異常を**アクター自身の手番**で減らす方式
  (本家 `process_player` / `process_monsters` ―― [[D-93]])
- ルーン式鑑定・改修品(ego)・固有機材(artifact)・パーマデスといった設計の骨格

### 1.3 Angband **由来ではない**もの

- **コードは全て独自**。本家は C、こちらはバニラ JavaScript
- **コンテンツは全て独自** ―― 敵・アイテム・刻印・系統・ロール・サイト・
  ログ断片・世界観・文章。`src/data/*.json` に Angband のデータは1件も含まれない
- **用語も独自**。`potion` `scroll` `wand` `orc` `dragon` 等の原語は
  コードにもデータにも書かない(これは [CLAUDE.md](CLAUDE.md) の不変条件6でもある)

---

## 2. 第三者のコード・アセット

**無い。**

- 外部ライブラリ・CDN・npm パッケージへの依存はゼロ(単一HTML・オフライン動作)
- 同梱フォントは無い。CSS は `Consolas` / `DejaVu Sans Mono` / `Courier New` /
  `monospace` を**名前で指定**しているだけで、フォントファイルは配布物に含まれない
- 画像・音声も無い。画面は全て canvas に文字を描いている
- `tools/shot.js` と `tools/check_render.js` は**開発時のみ**、
  利用者の環境に既にある Chrome / Edge を起動する。配布物には含まれない

---

## 3. 生成物

`index.html` / `src/js/data-gen.js` / `docs/reference/**` は
`src/` と `src/data/*.json` から生成される([build.py](build.py) /
[tools/gen_reference.js](tools/gen_reference.js))。
配布されるのは生成された `index.html` 1つだが、
**その対応するソースはこのリポジトリ全体**であり、GPL v2 第3条の求める
「完全な対応ソースコード」はここにある。

<https://github.com/istintone/xangband>

`index.html` を単体で受け取った人も、ファイル先頭の告知からこの場所に辿り着ける。
