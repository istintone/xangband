#!/usr/bin/env node
/* STRATA — GNU GPL v2. 条文は LICENSE、由来は NOTICE.md。 */
// -*- coding: utf-8 -*-
/**
 * 企画書の整合性検査 (docs/06-doc-rules.md の C-1〜C-10)
 *
 *   node tools/check_docs.js          検査
 *   node tools/check_docs.js --quiet  失敗のみ表示
 *
 * 生成器やデータが未整備の段階では該当検査を skip として報告し、失敗にはしない。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

const results = [];
let cur = null;
function check(id, title) { cur = { id, title, state: 'pass', notes: [] }; results.push(cur); }
function fail(msg) { cur.state = 'fail'; cur.notes.push('FAIL: ' + msg); }
function skip(msg) { if (cur.state !== 'fail') cur.state = 'skip'; cur.notes.push(msg); }
function note(msg) { cur.notes.push(msg); }

// ---------- 読み込み ----------
const rel = p => path.relative(ROOT, p).split(path.sep).join('/');
const read = p => fs.readFileSync(p, 'utf8');
const exists = p => fs.existsSync(p);

/** docs/ 直下 + ルートの .md を集める (docs/reference は生成物なので別扱い) */
function collectMd() {
  const out = [];
  for (const f of fs.readdirSync(ROOT)) {
    if (f.endsWith('.md')) out.push(path.join(ROOT, f));
  }
  const d = path.join(ROOT, 'docs');
  if (exists(d)) {
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.md')) out.push(path.join(d, f));
    }
  }
  return out.sort();
}

/** ごく単純な YAML フロントマター (key: value のみ) */
function parseFrontMatter(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const fm = {};
  for (const line of text.slice(4, end).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

/** コードフェンスとインラインコードを空白に潰す (記法の例示を検査対象外にする) */
function stripCode(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '))
    .replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
}

/** GitHub 互換の見出しスラグ */
function slugify(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function headingSlugs(text) {
  const set = new Set();
  const counts = new Map();
  for (const line of stripCode(text).split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    const s = slugify(m[1]);
    if (!s) continue;
    const n = counts.get(s) || 0;
    counts.set(s, n + 1);
    set.add(n === 0 ? s : s + '-' + n);
  }
  return set;
}

// ---------- 収集 ----------
const docs = collectMd().map(p => {
  const text = read(p);
  const r = rel(p);
  return { path: p, rel: r, text, fm: parseFrontMatter(text), isDoc: r === 'SPEC.md' || r.startsWith('docs/') };
});
const specDocs = docs.filter(d => d.isDoc);

// ============ C-1: フロントマター ============
check('C-1', '全 docs にフロントマターがある');
{
  const REQUIRED = ['doc', 'title', 'spec_version', 'updated', 'status'];
  const STATUSES = ['draft', 'review', 'fixed', 'obsolete'];
  for (const d of specDocs) {
    if (!d.fm) { fail(d.rel + ': フロントマターが無い'); continue; }
    for (const k of REQUIRED) if (!d.fm[k]) fail(d.rel + ": フロントマターに '" + k + "' が無い");
    if (d.fm.status && !STATUSES.includes(d.fm.status)) {
      fail(d.rel + ": status '" + d.fm.status + "' は不正 (" + STATUSES.join('|') + ')');
    }
    if (d.fm.updated && !/^\d{4}-\d{2}-\d{2}$/.test(d.fm.updated)) {
      fail(d.rel + ": updated '" + d.fm.updated + "' は YYYY-MM-DD 形式でない");
    }
  }
  note('対象 ' + specDocs.length + ' 文書');
}

// ============ C-2: spec_version 一致 ============
check('C-2', 'spec_version が全文書で一致');
{
  const vs = new Map();
  for (const d of specDocs) {
    const v = d.fm && d.fm.spec_version;
    if (!v) continue;
    if (!vs.has(v)) vs.set(v, []);
    vs.get(v).push(d.rel);
  }
  if (vs.size > 1) for (const [v, list] of vs) fail('v' + v + ': ' + list.join(', '));
  else if (vs.size === 1) note('全文書 v' + [...vs.keys()][0]);
}

// ============ C-3: doc ID 重複 ============
check('C-3', 'doc ID が重複していない');
const byDocId = new Map();
for (const d of specDocs) {
  const id = d.fm && d.fm.doc;
  if (!id) continue;
  if (byDocId.has(id)) fail("doc '" + id + "' が重複: " + byDocId.get(id).rel + ' と ' + d.rel);
  else byDocId.set(id, d);
}

// ============ C-4: SPEC.md の索引が過不足ない ============
check('C-4', 'SPEC.md の索引が docs/*.md を過不足なく列挙');
{
  const spec = docs.find(d => d.rel === 'SPEC.md');
  if (!spec) fail('SPEC.md が無い');
  else {
    const listed = new Set();
    for (const m of spec.text.matchAll(/\]\((docs\/[^)#]+\.md)[^)]*\)/g)) listed.add(m[1]);
    const actual = specDocs.filter(d => d.rel.startsWith('docs/')).map(d => d.rel);
    for (const a of actual) if (!listed.has(a)) fail('索引に未掲載: ' + a);
    for (const l of listed) if (!exists(path.join(ROOT, l))) fail('索引が存在しない文書を指している: ' + l);
    note('索引 ' + listed.size + ' 件 / 実在 ' + actual.length + ' 件');
  }
}

// ============ C-5: 相対リンクの解決 (アンカー含む) ============
check('C-5', 'Markdown の相対リンクが解決する');
{
  let n = 0;
  const slugCache = new Map();
  const slugsOf = p => {
    if (!slugCache.has(p)) slugCache.set(p, headingSlugs(read(p)));
    return slugCache.get(p);
  };
  for (const d of docs) {
    for (const m of stripCode(d.text).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(href)) continue;
      n++;
      const hash = href.indexOf('#');
      const fp = hash === -1 ? href : href.slice(0, hash);
      const anchor = hash === -1 ? '' : href.slice(hash + 1);
      const target = path.resolve(path.dirname(d.path), fp);
      if (!exists(target)) { fail(d.rel + ': リンク先が無い -> ' + href); continue; }
      if (anchor && target.endsWith('.md') && !slugsOf(target).has(anchor)) {
        fail(d.rel + ': アンカーが無い -> ' + href);
      }
    }
  }
  note('相対リンク ' + n + ' 件');
}

// ============ C-7: D-nn / Q-nn の重複 ============
const definedIds = new Set();
check('C-7', 'D-nn / Q-nn に重複が無い');
{
  const dec = docs.find(d => d.rel === 'docs/05-decisions-backlog.md');
  if (!dec) skip('docs/05-decisions-backlog.md が無い');
  else {
    const seen = new Map();
    // 解決済みは `~~Q-11~~` と取り消し線で書くが、ID は永続なので定義として数える
    // ([[D-17]]: ID は改名・再利用・削除しない)。取り消し線は表示上のものにすぎない。
    for (const m of stripCode(dec.text).matchAll(/^\|\s*~{0,2}([DQMR]-\d+)~{0,2}\s*\|/gm)) {
      seen.set(m[1], (seen.get(m[1]) || 0) + 1);
      definedIds.add(m[1]);
    }
    for (const [id, c] of seen) if (c > 1) fail(id + ' が ' + c + ' 回定義されている');
    note('定義済み ID ' + definedIds.size + ' 件');
  }
}

// ============ C-6: [[...]] 相互参照 ============
check('C-6', '[[...]] 相互参照が解決する');
{
  const NS_FILE = {
    mon: 'monsters.json', item: 'items.json', ego: 'egos.json', uniq: 'uniques.json',
    lin: 'lineages.json', role: 'roles.json', site: 'sites.json', term: 'glossary.json',
    ability: 'abilities.json', module: 'modules.json',
  };
  const nsIds = {};
  for (const ns of Object.keys(NS_FILE)) {
    const p = path.join(ROOT, 'src', 'data', NS_FILE[ns]);
    if (!exists(p)) { nsIds[ns] = null; continue; }
    try {
      const json = JSON.parse(read(p));
      const arr = Array.isArray(json) ? json : (json.entries || Object.values(json));
      nsIds[ns] = new Set(arr.map(e => e && e.id).filter(Boolean));
    } catch (e) {
      fail('src/data/' + NS_FILE[ns] + ' が JSON として読めない: ' + e.message);
      nsIds[ns] = null;
    }
  }

  const missingData = new Set();
  let n = 0;
  for (const d of docs) {
    for (const m of stripCode(d.text).matchAll(/\[\[([^\]]+)\]\]/g)) {
      const ref = m[1].trim();
      n++;
      if (/^[DQMR]-\d+$/.test(ref)) {
        if (definedIds.size === 0) skip('D/Q ID の定義元が未整備');
        else if (!definedIds.has(ref)) fail(d.rel + ': 未定義の ID -> [[' + ref + ']]');
        continue;
      }
      const mm = ref.match(/^([a-z]+):([^#]+?)(?:#(.*))?$/);
      if (!mm) { fail(d.rel + ': 記法が不正 -> [[' + ref + ']]'); continue; }
      const ns = mm[1], id = mm[2];
      if (ns === 'doc') {
        if (!byDocId.has(id)) fail(d.rel + ': 未知の doc ID -> [[' + ref + ']]');
        continue;
      }
      if (!(ns in NS_FILE)) { fail(d.rel + ': 未知の名前空間 -> [[' + ref + ']]'); continue; }
      if (nsIds[ns] === null) { missingData.add(NS_FILE[ns]); continue; }
      if (!nsIds[ns].has(id)) fail(d.rel + ': ' + NS_FILE[ns] + " に id '" + id + "' が無い -> [[" + ref + ']]');
    }
  }
  note('相互参照 ' + n + ' 件');
  if (missingData.size) skip('未整備のデータを参照 (検査保留): ' + [...missingData].join(', '));
}

// ============ C-8: fixed 文書に【暫定】が無い ============
check('C-8', 'status:fixed の文書に【暫定】が残っていない');
{
  let checked = 0;
  for (const d of specDocs) {
    if (!d.fm || d.fm.status !== 'fixed') continue;
    checked++;
    // stripCode は行数と桁数を保つので、行番号はそのまま使える
    stripCode(d.text).split('\n').forEach((line, i) => {
      if (line.includes('【暫定】')) fail(d.rel + ':' + (i + 1) + ' に【暫定】が残っている');
    });
  }
  if (checked === 0) skip('status:fixed の文書がまだ無い');
  else note('fixed 文書 ' + checked + ' 件');
}

// ============ C-9: 生成物が最新 ============
check('C-9', '生成物 (docs/reference) が最新');
{
  const gen = path.join(ROOT, 'tools', 'gen_reference.js');
  const refDir = path.join(ROOT, 'docs', 'reference');
  if (!exists(gen)) skip('tools/gen_reference.js が未実装 (M1 で導入)');
  else if (!exists(refDir)) skip('docs/reference/ がまだ無い');
  else {
    for (const f of fs.readdirSync(refDir)) {
      if (!f.endsWith('.md')) continue;
      const head = read(path.join(refDir, f)).split('\n').slice(0, 3).join('\n');
      if (!/GENERATED by/.test(head)) fail('docs/reference/' + f + ': 生成バナーが無い (手書きの疑い)');
    }
    // 再生成して差分が出たら落とす (docs/06 §6.7)
    const r = require('child_process').spawnSync(
      process.execPath, [gen, '--check'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) {
      fail('生成物が古い: ' + String(r.stdout || r.stderr).trim().split('\n')[0]);
    }
    note('生成バナーと再生成差分を確認');
  }
}

// ============ C-10: docs に個体データの一覧が手書きされていないか ============
check('C-10', 'docs に個体データの一覧が手書きされていない (警告のみ)');
{
  const LIMIT = 20;
  let warned = 0;
  for (const d of specDocs) {
    if (d.rel === 'docs/05-decisions-backlog.md') continue;
    const lines = stripCode(d.text).split('\n');
    let run = 0, start = 0;
    const flush = () => {
      if (run >= LIMIT) { note(d.rel + ':' + start + ' 付近に ' + run + ' 行の表 (data 化を検討)'); warned++; }
      run = 0;
    };
    lines.forEach((line, i) => {
      if (/^\s*\|.*\|\s*$/.test(line)) { if (run === 0) start = i + 1; run++; }
      else flush();
    });
    flush();
  }
  if (warned === 0) note('大きな手書き表は見つからなかった');
}

// ---------- 出力 ----------
let failed = 0, skipped = 0;
for (const r of results) {
  if (r.state === 'fail') failed++;
  else if (r.state === 'skip') skipped++;
  const mark = r.state === 'pass' ? 'PASS' : r.state === 'skip' ? 'SKIP' : 'FAIL';
  if (!QUIET || r.state === 'fail') {
    console.log('[' + mark + '] ' + (r.id + '     ').slice(0, 5) + ' ' + r.title);
    for (const nn of r.notes) console.log('         - ' + nn);
  }
}
console.log('');
console.log((results.length - failed - skipped) + ' pass / ' + skipped + ' skip / ' + failed + ' fail');
process.exit(failed ? 1 : 0);
