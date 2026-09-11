#!/usr/bin/env python3
# -*- coding: utf-8 -*-
# STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。
"""
STRATA ビルドスクリプト

`index.dev.html` を正本(テンプレート兼 結合順の定義)として、
BUILD:CSS / BUILD:JS ブロックの外部参照をインライン展開し、
配布物 `index.html` (単一ファイル・オフライン動作) を生成する。

card-eleven と違い、結合順のリストをスクリプト側に持たない。
index.dev.html の <script> の並びが唯一の正本 ([[D-23]] / docs/01 §1.2)。
src/tests/_setup.js と tools/check_code.js も同じファイルを読む。

使い方:
    python build.py           # ビルド
    python build.py --check   # ビルドせず、index.html が最新かだけ検証
"""
import re
import sys
import json
import pathlib

ROOT = pathlib.Path(__file__).parent
DEV = ROOT / "index.dev.html"
OUT = ROOT / "index.html"
DATA_DIR = ROOT / "src" / "data"
DATA_GEN = ROOT / "src" / "js" / "data-gen.js"

CSS_BLOCK = re.compile(r"<!-- BUILD:CSS -->(.*?)<!-- /BUILD:CSS -->", re.S)
JS_BLOCK = re.compile(r"<!-- BUILD:JS -->(.*?)<!-- /BUILD:JS -->", re.S)

LINK_RE = re.compile(r'<link[^>]*href="([^"]+)"[^>]*>')
SCRIPT_RE = re.compile(r'<script[^>]*src="([^"]+)"[^>]*>\s*</script>')


def parse_scripts(dev_text):
    """index.dev.html の BUILD:JS ブロックから (path, layer) を順に取り出す。

    このパーサは build.py / _setup.js / check_code.js の三者が同じ結果を
    得ることを前提にしている。書式を変えるときは三箇所とも直すこと。
    """
    m = JS_BLOCK.search(dev_text)
    if not m:
        raise SystemExit("index.dev.html に BUILD:JS ブロックが無い")
    out = []
    for tag in re.finditer(r"<script[^>]*>\s*</script>", m.group(1)):
        s = tag.group(0)
        src = re.search(r'src="([^"]+)"', s)
        if not src:
            continue
        layer = re.search(r'data-layer="([^"]+)"', s)
        out.append((src.group(1), layer.group(1) if layer else "shell"))
    return out


def parse_styles(dev_text):
    m = CSS_BLOCK.search(dev_text)
    if not m:
        raise SystemExit("index.dev.html に BUILD:CSS ブロックが無い")
    return LINK_RE.findall(m.group(1))


def read(rel):
    p = ROOT / rel
    if not p.exists():
        raise SystemExit("参照先が無い: %s" % rel)
    return p.read_text(encoding="utf-8").strip()


def render_data_gen():
    """src/data/*.json を単一のJSモジュール src/js/data-gen.js に変換する ([[D-25]])。

    単一HTML・外部依存ゼロなので fetch が使えない(file:// で動かない)。
    正本は JSON のまま保つ ─ 参照表/スポイラー生成器はそちらを読む。
    キーはファイル名のベース名 (monsters.json -> RAW.monsters)。
    """
    if not DATA_DIR.exists():
        return None
    files = sorted(DATA_DIR.glob("*.json"))
    if not files:
        return None

    parts = []
    for f in files:
        try:
            obj = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SystemExit("JSON が壊れている: src/data/%s — %s" % (f.name, e))
        # _comment は開発者向けの注記なので配布物には含めない
        if isinstance(obj, dict):
            obj = {k: v for k, v in obj.items() if not k.startswith("_")}
        body = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
        parts.append("  %s: %s" % (json.dumps(f.stem), body))

    return (
        "/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */\n"
        "/* data-gen.js — 自動生成物。編集しないこと。\n"
        " * 正本: src/data/*.json  /  生成: python build.py  ([[D-25]])\n"
        " * 素の JSON をそのまま載せるだけ。索引の構築は data.js が行う。\n"
        " */\n"
        "'use strict';\n\n"
        "var RAW = {\n" + ",\n".join(parts) + "\n};\n\n"
        "if (typeof module !== 'undefined' && module.exports) module.exports = RAW;\n"
    )


LICENSE_BANNER = """<!--
  STRATA (codename: xangband)
  Copyright (C) 2026  istintone

  This program is free software; you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation; version 2.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program; if not, see <https://www.gnu.org/licenses/>.

  Angband (GPL v2) の機構を継承している。写している数値表と、
  構造だけ踏襲している箇所の一覧は NOTICE.md にある。
  対応するソースコード一式: https://github.com/istintone/xangband
-->"""


def render():
    dev = DEV.read_text(encoding="utf-8")

    css = "\n\n".join("/* ---- %s ---- */\n%s" % (p, read(p)) for p in parse_styles(dev))
    js = "\n\n".join(
        "/* ==== %s (%s) ==== */\n%s" % (p, layer, read(p))
        for p, layer in parse_scripts(dev)
    )

    out = CSS_BLOCK.sub(lambda _: "<style>\n%s\n</style>" % css, dev)
    out = JS_BLOCK.sub(lambda _: "<script>\n%s\n</script>" % js, out)

    # 開発用の注記を配布物向けに差し替える
    out = out.replace(
        "<!--\n  開発用エントリ。",
        "<!--\n  自動生成物 — 編集しないこと (正本: index.dev.html + src/, 生成: build.py)。\n  もと: 開発用エントリ。",
    )
    # 配布されるのはこの1ファイルなので、告知もこの中に入れる (GPL v2 §1)
    out = out.replace("</title>", "</title>\n" + LICENSE_BANNER, 1)
    return out


def main():
    check = "--check" in sys.argv

    # data-gen.js は index.html より先に作る (render() が読むため)
    data_js = render_data_gen()
    if data_js is not None:
        if check:
            cur = DATA_GEN.read_text(encoding="utf-8") if DATA_GEN.exists() else None
            if cur != data_js:
                print("FAIL: src/js/data-gen.js が src/data/*.json と一致しない。python build.py を実行すること")
                return 1
        else:
            DATA_GEN.write_text(data_js, encoding="utf-8", newline="\n")

    new = render()

    if check:
        if not OUT.exists():
            print("FAIL: index.html が無い。python build.py を実行すること")
            return 1
        old = OUT.read_text(encoding="utf-8")
        if old != new:
            print("FAIL: index.html が src/ と一致しない。python build.py を実行すること")
            return 1
        print("OK: index.html と data-gen.js は最新")
        return 0

    OUT.write_text(new, encoding="utf-8", newline="\n")
    scripts = parse_scripts(DEV.read_text(encoding="utf-8"))
    rule = sum(1 for _, l in scripts if l == "rule")
    print("built index.html  (%d KB / js %d files: rule %d, shell %d)"
          % (len(new) // 1024, len(scripts), rule, len(scripts) - rule))
    return 0


if __name__ == "__main__":
    sys.exit(main())
