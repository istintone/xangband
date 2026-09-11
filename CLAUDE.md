# CLAUDE.md — このリポジトリでの作業規約

**プロジェクト**: STRATA (codename: xangband) — Angband の機構を継承したSF探索ローグライク。
仕様の正本は [SPEC.md](SPEC.md)。文書運用の詳細は [docs/06-doc-rules.md](docs/06-doc-rules.md)。

---

## 必ず守ること

### 1. 企画書は「変更のたびに」更新する
仕様に関わる変更をしたら、**同じ作業のうちに** docs を更新する。後回しにしない。

```
① docs/*.md を更新   ← 実装より先
② 実装 / src/data を変更
③ node tools/gen_reference.js   (生成物の再生成)
④ node tools/check_docs.js && python build.py --check
⑤ CHANGELOG.md に追記
```

**docs と実装が食い違ったら docs を正**とする。docs 側が誤りだと判断した場合のみ、
理由を `docs/05-decisions-backlog.md` の D-nn に残して docs を直す。

### 2. 判断したら D-nn、迷ったら Q-nn
- 設計判断をしたら `docs/05` の**決定事項に D-nn を追記**する(理由を必ず書く)。
- 決めきれず先送りしたら **Q-nn を追記**する。黙って放置しない。
- Q-nn を解決したら `resolved` にし、D-nn として昇格させる。
- **ID は再利用・改名しない**(wiki の permalink が壊れる)。廃止は `obsolete` にして残す。

### 3. 数値の一覧を docs に手書きしない
敵・アイテム・系統などの一覧表は **`src/data/*.json` が唯一の正本**。
docs には「設計上の意図を持った代表値」だけを書く。
一覧は `docs/reference/**`(生成物)へのリンクで参照する。

**`docs/reference/**` と `dist/**` は生成物。絶対に手で編集しない。**

### 4. 相互参照は `[[ns:id]]` で書く
`[[mon:cleaner-drone]]` `[[item:plasma-cutter]]` `[[term:seal]]` `[[D-03]]` など。
後から wiki のリンクへ機械変換するため。記法は [docs/06-doc-rules.md](docs/06-doc-rules.md#66-相互参照の記法-スポイラーwiki-化の鍵) 参照。

### 5. コードの不変条件(破ると設計が崩れる)
1. **`Math.random()` の使用禁止。** 乱数は `src/js/rng.js` 経由のみ(シード決定論が全テストの土台)
2. **深度(Depth)は全サイト共通の絶対値。** サイトが強さの基準を変えない
3. **ルール層(gen/actor/combat/item/ability/hazard/power)は DOM 非依存**
4. **エネルギー消費のない行動を作らない**(メタ操作は明確に分離)
5. **外部依存ゼロ。** ライブラリ/CDN を追加しない。単一HTML・オフライン動作を壊さない
6. 用語は **SF語**を使う(`ampule` `protocol` `implant`…)。`potion` `scroll` `ring` 等の原語をコードに書かない

---

## ビルドと検査

```sh
python build.py            # src/ を index.html に埋め込む
python build.py --check    # index.html と src の一致を検証
node tools/check_docs.js   # 企画書の整合性を検査(§docs/06.9)
```

開発中は `index.dev.html` を開けばビルド不要で反復できる。
`src/js/*.js` の**結合順を変えたら `build.py` と `src/tests/_setup.js` の両方**を更新する。
`boot.js` は副作用(起動)を持つので**必ず最後**。

---

## 作業を始めるときに読む順

1. [SPEC.md](SPEC.md) — 索引
2. [docs/04-roadmap.md](docs/04-roadmap.md) — 今どのマイルストーンか
3. 該当する仕様書
4. [docs/05-decisions-backlog.md](docs/05-decisions-backlog.md) — 既に決まっている判断を蒸し返さない
