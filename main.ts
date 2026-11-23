// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

/** A file as lines: its line break, and whether it ends with one (SPEC.md section 3). */
interface Split {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): Split {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: Split): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function trimEndWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function trimWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** One line against one line at a tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position where O occurs in lines at a tier, from `from` on. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface Found {
  tier: number;
  occ: number[];
}

/** The first tier at which O occurs (at or after `from`; an end-of-file search takes only occurrences ending at the last line). */
function findTier(lines: string[], o: string[], strict: boolean, from: number, eof: boolean): Found | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, o, t, from);
    if (eof) occ = occ.filter((p) => p + o.length === lines.length);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to a single-line anchor, at the first tier where one is. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

/**
 * The new lines for a replacement. A context line of N (nCtx[i] is its index in O) is written as the file's own
 * matched line, never the patch's. At tier 2 every other line of N is re-indented: P, the leading spaces and tabs
 * of O's first line, is replaced by F, those of the file's first matched line, on lines that start with P.
 */
function buildNew(o: string[], n: string[], nCtx: (number | null)[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  const p = o.length > 0 ? leadWs(o[0]!) : '';
  const f = o.length > 0 ? leadWs(fileLines[pos]!) : '';
  for (let i = 0; i < n.length; i++) {
    const c = nCtx[i]!;
    if (c !== null) {
      out.push(fileLines[pos + c]!);
      continue;
    }
    const line = n[i]!;
    if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(p)) out.push(f + line.slice(p.length));
    else out.push(line);
  }
  return out;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** One unified hunk: A is the old start line (1-based); noNl says a `\` line follows its last context or `+` line; noNlPlus the same for its last `+` line. */
interface UHunk {
  a: number;
  o: string[];
  n: string[];
  nCtx: (number | null)[];
  noNl: boolean;
  noNlPlus: boolean;
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  remove: boolean;
  hunks: UHunk[];
}

/** The path after `--- ` or `+++ `: the text after the four characters, up to the first tab, spaces removed. */
function pathOf(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  return (tab >= 0 ? t.slice(0, tab) : t).trim();
}

/** One leading `a/` or `b/` removed. */
function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function buildHunk(a: number, raw: string[]): UHunk {
  interface Entry {
    kind: 'ctx' | 'old' | 'new';
    text: string;
    bs: boolean;
  }
  const entries: Entry[] = [];
  for (const l of raw) {
    if (l.startsWith('\\')) {
      // A `\` line refers to the body line before it.
      if (entries.length > 0) entries[entries.length - 1]!.bs = true;
      continue;
    }
    if (l === '') entries.push({ kind: 'ctx', text: '', bs: false });
    else if (l.startsWith(' ')) entries.push({ kind: 'ctx', text: l.slice(1), bs: false });
    else if (l.startsWith('-')) entries.push({ kind: 'old', text: l.slice(1), bs: false });
    else entries.push({ kind: 'new', text: l.slice(1), bs: false });
  }
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  for (const e of entries) {
    if (e.kind === 'ctx') {
      o.push(e.text);
      n.push(e.text);
      nCtx.push(o.length - 1);
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push(e.text);
      nCtx.push(null);
    }
  }
  let noNl = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]!.kind === 'ctx' || entries[k]!.kind === 'new') {
      noNl = entries[k]!.bs;
      break;
    }
  }
  let noNlPlus = false;
  for (let k = entries.length - 1; k >= 0; k--) {
    if (entries[k]!.kind === 'new') {
      noNlPlus = entries[k]!.bs;
      break;
    }
  }
  return { a, o, n, nCtx, noNl, noNlPlus };
}

/** Apply a section's hunks in order to a file's lines, each to the result of the ones before it. */
function applyHunks(f: Split, hunks: UHunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, f.lines.length));
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...h.n);
      if (atEnd) f.final = !h.noNl;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const p of found.occ) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const atEnd = best + h.o.length === f.lines.length;
    const repl = buildNew(h.o, h.n, h.nCtx, f.lines, best, found.tier);
    f.lines.splice(best, h.o.length, ...repl);
    if (atEnd) f.final = !h.noNl;
    d += h.n.length - h.o.length;
  }
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  return (tree) => {
    const oldP = s.pairOld ?? s.renameFrom ?? s.gitOld;
    const newP = s.pairNew ?? s.renameTo ?? s.gitNew;
    if (oldP === null && newP === null) return;
    const oldPath = oldP ?? newP!;
    const newPath = newP ?? oldP!;
    if (oldPath === '/dev/null' || s.create) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const ls: string[] = [];
      let lastPlus: UHunk | null = null;
      for (const h of s.hunks) {
        let hasPlus = false;
        for (let k = 0; k < h.n.length; k++) {
          if (h.nCtx[k] === null) {
            ls.push(h.n[k]!);
            hasPlus = true;
          }
        }
        if (hasPlus) lastPlus = h;
      }
      const final = lastPlus === null ? true : !lastPlus.noNlPlus;
      tree.now.set(newPath, ls.length === 0 ? '' : ls.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (newPath === '/dev/null' || s.remove) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const before = tree.get(oldPath);
      if (before === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const f = splitFile(before);
      applyHunks(f, s.hunks, strict, oldPath);
      tree.now.set(oldPath, null);
      tree.now.set(newPath, joinFile(f));
      tree.moves.push([oldPath, newPath]);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const f = splitFile(before);
    applyHunks(f, s.hunks, strict, oldPath);
    tree.now.set(oldPath, joinFile(f));
  };
}

/** Read a unified diff (SPEC.md section 6) into one edit per section. */
function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (): USection => {
    const s: USection = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, create: false, remove: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line) ?? /^diff --git "a\/(.*)" "b\/(.*)"\s*$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = startSection();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      inHeader = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const raw: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          raw.push(b);
          j++;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      cur.hunks.push(buildHunk(Number(m[1]), raw));
      i = j;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !inHeader) {
        cur = startSection();
        inHeader = true;
      }
      cur.pairOld = stripAB(pathOf(line));
      cur.pairNew = stripAB(pathOf(lines[i + 1]!));
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.create = true;
      else if (line.startsWith('deleted file mode')) cur.remove = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = findTier(f.lines, oldLines, strict, 0, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const repl = buildNew(oldLines, newLines, newLines.map(() => null), f.lines, pos, found.tier);
    f.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, joinFile(f));
  };
}

/** Read SEARCH/REPLACE blocks (SPEC.md section 7) into one edit per block. */
function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine}`);
      path = prevPath;
    }
    let k = i + 1;
    let eq = -1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '=======') {
        eq = k;
        break;
      }
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE' || lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      k++;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchLine}`);
    let rep = -1;
    k = eq + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = k;
        break;
      }
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') break;
      k++;
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchLine}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

/** One V4A chunk: an anchor line, or none; eof anchors it to the end of the file. */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: string[];
  n: string[];
  nCtx: (number | null)[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (at === -1) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f.lines.splice(at, 0, ...ch.n);
        cursor = at + ch.n.length;
        continue;
      }
      const found = findTier(f.lines, ch.o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.occ[0]!;
      const repl = buildNew(ch.o, ch.n, ch.nCtx, f.lines, pos, found.tier);
      f.lines.splice(pos, ch.o.length, ...repl);
      cursor = pos + repl.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

/** Collect a V4A section's raw lines: until the next section start or the `*** End Patch` line. */
function collectSection(lines: string[], from: number, endPatch: number): { lines: string[]; lineNos: number[]; next: number } {
  const out: string[] = [];
  const nos: number[] = [];
  let i = from;
  while (i < endPatch) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
    out.push(l);
    nos.push(i + 1);
    i++;
  }
  return { lines: out, lineNos: nos, next: i };
}

/** Read a V4A patch (SPEC.md section 8) into one edit per section. */
function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const raw = collectSection(lines, i, last);
      i = raw.next;
      while (raw.lines.length > 0 && blank(raw.lines[raw.lines.length - 1]!)) {
        raw.lines.pop();
        raw.lineNos.pop();
      }
      const fileLines: string[] = [];
      for (let k = 0; k < raw.lines.length; k++) {
        const l = raw.lines[k]!;
        if (l.startsWith('+')) fileLines.push(l.slice(1));
        else if (l === '') fileLines.push('');
        else throw new Exit2(`error: parse ${raw.lineNos[k]!}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      const raw = collectSection(lines, i, last);
      i = raw.next;
      while (raw.lines.length > 0 && blank(raw.lines[raw.lines.length - 1]!)) {
        raw.lines.pop();
        raw.lineNos.pop();
      }
      if (raw.lines.length > 0) throw new Exit2(`error: parse ${raw.lineNos[0]!}`);
      edits.push(v4aDeleteEdit(path));
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      const raw = collectSection(lines, i, last);
      i = raw.next;
      while (raw.lines.length > 0 && blank(raw.lines[raw.lines.length - 1]!)) {
        raw.lines.pop();
        raw.lineNos.pop();
      }
      let idx = 0;
      let moveTo: string | null = null;
      if (raw.lines.length > 0 && raw.lines[0]!.startsWith('*** Move to: ')) {
        moveTo = raw.lines[0]!.slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (; idx < raw.lines.length; idx++) {
        const l = raw.lines[idx]!;
        const ln = raw.lineNos[idx]!;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, o: [], n: [], nCtx: [] };
          chunks.push(cur);
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${ln}`);
          cur.eof = true;
          cur = null;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${ln}`);
            cur = { anchor: null, eof: false, o: [], n: [], nCtx: [] };
            chunks.push(cur);
          }
          if (l.startsWith(' ')) {
            cur.o.push(l.slice(1));
            cur.n.push(l.slice(1));
            cur.nCtx.push(cur.o.length - 1);
          } else if (l.startsWith('-')) {
            cur.o.push(l.slice(1));
          } else if (l.startsWith('+')) {
            cur.n.push(l.slice(1));
            cur.nCtx.push(null);
          } else {
            cur.o.push('');
            cur.n.push('');
            cur.nCtx.push(cur.o.length - 1);
          }
        } else {
          throw new Exit2(`error: parse ${ln}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSR(lines, strict) : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [o, n] of tree.moves) {
    // A move prints `R <old> -> <new>` (sorted by <new>) when <old> existed before the patch and does not after it,
    // and <new> did not exist before it and does after it; it replaces that pair's D and A lines.
    if (tree.original(o) !== null && tree.original(n) === null && tree.get(n) !== null && tree.get(o) === null) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      movedOld.add(o);
      movedNew.add(n);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
