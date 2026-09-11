---
doc: spec
title: 仕様書SPEC(索引)
spec_version: 0.6
updated: 2026-09-09
status: draft
---

# STRATA (コードネーム: xangband) — 仕様書 SPEC(索引)

> **この文書群がプロジェクトの正本(Single Source of Truth)です。**
> 実装とSPECが食い違った場合、原則SPECを正とする。
> **更新の手順・義務・検査は [docs/06-doc-rules.md](docs/06-doc-rules.md) に定義されている。**
> 企画書は「一度書いて終わり」ではなく、変更のたびに同じ作業のうちに更新する。

- **バージョン**: SPEC v0.7 (M3b 完了 / M4a 完了 ― 終端まで通る) — 変更履歴は [CHANGELOG.md](CHANGELOG.md)
- **形式**: 単一HTMLファイル(`index.html`)。外部依存なし、オフライン動作。
- **想定プレイ**: PCキーボード操作・1人プレイ。1ラン 5〜30時間(パーマデス)。
- **コンセプト**: **Angband の機構をそのまま継承した、SF世界の深層探索ローグライク。**

---

## この企画の一行要約

> 恒星間サルベージ船の乗員となり、**漂流艦 / 異星遺跡 / 超高層都市 / 灰の地表**という
> 4つの現場を、共通の「深度」スケールで **深度100** まで潜り抜ける。
> ゲーム機構(ターン制・深度スケーリング・鑑定・エゴ/固有品・パーマデス)は
> Angband 準拠。用語と見た目は初日から一貫してSF。

---

## 仕様ドキュメント(docs/)

| # | ドキュメント | 主な内容 |
|---|---|---|
| 0 | [企画コンセプト](docs/00-concept.md) | 世界観・4サイト統合の設計・Angbandとの差分・何が新しいか |
| 1 | [アーキテクチャと技術仕様](docs/01-architecture.md) | 構成・モジュール分割・ビルド・永続化・不変条件 |
| 2 | [コア機構(Angband準拠)](docs/02-core-rules.md) | エネルギー式ターン・視界・深度スケーリング・戦闘・生成 |
| 3 | [キャラクターとコンテンツ](docs/03-content.md) | 系統/ロール/能力値・アイテム/鑑定・敵・SF読み替え対応表 |
| 4 | [開発ロードマップ](docs/04-roadmap.md) | M0〜M5マイルストーンと各段の受け入れ基準 |
| 5 | [決定事項ログとバックログ](docs/05-decisions-backlog.md) | なぜその設計にしたか・未決事項・将来候補 |
| 6 | [**文書運用ルール**](docs/06-doc-rules.md) | 正本の三層・更新手順と義務・ID規約・相互参照記法・スポイラー/wiki生成 |

### 設計ドキュメント (M3 の前に確定させたもの)

| # | ドキュメント | 主な内容 |
|---|---|---|
| 7 | [最終ゴール設計](docs/07-endgame.md) | なぜ深度100まで潜るのか・《適合》4種・《起源》の正体・深度80〜100の構造 |
| 8 | [惑星環境の設計](docs/08-environment.md) | 星系・7つの環境値・気密・減圧の伝播・昼夜・サイト別プロファイル |
| 9 | [UIの設計](docs/09-ui.md) | 画面レイアウト改訂・注視/目標指定・情報の階層・色の意味 |
| 10 | [細部デザインの差別化設計](docs/10-differentiation.md) | サイト別の「次の一手」・アンチゴール・測れる判定指標 |
| 11 | [独自機構の実装設計](docs/11-subsystems.md) | 電脳層(縮小版)と認知・端末とジャックイン・加工/解体/移植 |

## 参照表(自動生成 — `node tools/gen_reference.js`)

`src/data/*.json` から生成する。**手書き禁止**(§[docs/06](docs/06-doc-rules.md) §6.1)。

| ファイル | 内容 | 正本 |
|---|---|---|
| [敵一覧](docs/reference/monsters.md) | 深度・HP・攻撃・警戒度 | `monsters.json` |
| [アイテム一覧](docs/reference/items.md) | 深度・重量・効果・価格 | `items.json` |
| [系統](docs/reference/lineages.md) | 8種の能力値補正・技能 | `lineages.json` |
| [ロール](docs/reference/roles.md) | 8種のサブシステム・技能 | `roles.json` |
| [能力一覧](docs/reference/abilities.md) | 必要Lv・コスト・失敗率 | `abilities.json` |
| [刻印一覧](docs/reference/sigils.md) | ルーン式鑑定の単位 | `sigils.json` |
| [改修品一覧](docs/reference/egos.md) | エゴの刻印と数値 | `egos.json` |
| [固有機材一覧](docs/reference/uniques.md) | 1ランに1個の固有装備 | `uniques.json` |
| [区画テンプレート](docs/reference/rooms.md) | 部屋と Vault の実マップ | `rooms.json` `vaults.json` |

> **生成済み。** データを変更したら `node tools/gen_reference.js` を実行すること
> (`check_docs.js` の C-9 が再生成差分を検査して落とす)。

## 用語の基準

本作の用語は「SF語」を正とする。Angband 由来の機構名は
[docs/03-content.md](docs/03-content.md) の**読み替え対応表**で対応付けを管理する。
実装コード内の識別子も **SF語**(例: `ampule`, `protocol`, `implant`)を使い、
`potion` `scroll` `ring` 等の原語は**使わない**(検索時の混乱を避けるため)。

新しい用語を作ったら `src/data/glossary.json` に登録する
(wiki 化の際にそのままページになる — [docs/06](docs/06-doc-rules.md) §6.7)。

## 検査

```sh
node tools/check_docs.js   # 企画書の整合性(フロントマター/リンク/ID/相互参照/生成物)
python build.py --check    # index.html と src/ の一致
```
