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
  /** Move edits (sections 6 and 8) that succeeded, in patch order; the output turns a pair into an R line. */
  readonly moves: { from: string; to: string }[] = [];
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

// ---------------------------------------------------------------------------
// Sections 5 to 8, written for this entry: the file line model, matching at
// three tiers, and the readers for unified diffs, SEARCH/REPLACE blocks and
// V4A patches. Each reader turns patch lines into edits; a parse fault throws
// Exit2 before any file is looked at, and an edit throws Fail when it cannot
// be applied to the tree as the earlier edits left it.

/** A file as section 3 sees it: its lines, its own line break, and whether it ends with one. */
interface FileModel {
  lines: string[];
  br: string;
  eol: boolean;
}

function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, eol: false };
  const parts = text.split(br);
  const eol = text.endsWith(br);
  if (eol) parts.pop();
  return { lines: parts, br, eol };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.eol ? m.br : '');
}

/** A created file's bytes (section 3): LF breaks, a final one exactly when `eol` says so. */
function createdText(lines: string[], eol: boolean): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + (eol ? '\n' : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

interface TierHit {
  tier: number;
  at: number[];
}

/**
 * Section 5: the first tier at which `old` occurs in `fileLines` at or after
 * index `from`, keeping only occurrences the optional `okPos` accepts. Null
 * when no tier has one. Occurrences may overlap, so every start is tried.
 */
function findTier(fileLines: string[], old: string[], strict: boolean, from = 0, okPos?: (pos: number) => boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const want = old.map((l) => normLine(l, tier));
    const at: number[] = [];
    for (let i = from; i + old.length <= fileLines.length; i += 1) {
      let ok = true;
      for (let j = 0; j < old.length; j += 1) {
        if (normLine(fileLines[i + j]!, tier) !== want[j]) {
          ok = false;
          break;
        }
      }
      if (ok && (okPos === undefined || okPos(i))) at.push(i);
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

/** One line of a replacement: `ctxAt` is its index in O when it is a context line, else -1. */
interface NLine {
  text: string;
  ctxAt: number;
}

/** Splice N over the matched lines, honouring section 5's context and tier-2 re-indent rules. */
function spliceLines(fileLines: string[], at: number, old: string[], n: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 && old.length > 0 ? leadWs(fileLines[at]!) : '';
  const p = tier === 2 && old.length > 0 ? leadWs(old[0]!) : '';
  for (const ln of n) {
    if (ln.ctxAt >= 0) {
      out.push(fileLines[at + ln.ctxAt]!);
      continue;
    }
    let t = ln.text;
    if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return [...fileLines.slice(0, at), ...out, ...fileLines.slice(at + old.length)];
}

/** A hunk or chunk body line, in body order. `noeol` is set when a `\` line follows it. */
interface BodyEntry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  noeol: boolean;
}

/** Split a body into O (context and `-` lines) and N (context and `+` lines), each in body order. */
function bodyON(entries: BodyEntry[]): { o: string[]; n: NLine[]; lastN: BodyEntry | null } {
  const o: string[] = [];
  const n: NLine[] = [];
  let lastN: BodyEntry | null = null;
  for (const e of entries) {
    if (e.kind === 'ctx') {
      const idx = o.length;
      o.push(e.text);
      n.push({ text: e.text, ctxAt: idx });
      lastN = e;
    } else if (e.kind === 'old') {
      o.push(e.text);
    } else {
      n.push({ text: e.text, ctxAt: -1 });
      lastN = e;
    }
  }
  return { o, n, lastN };
}

// --- Section 6: unified diffs ----------------------------------------------

interface UHunk {
  a: number;
  entries: BodyEntry[];
}

interface USection {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

/** The path a `--- ` or `+++ ` line names: up to the first tab, spaces removed, `/dev/null` as null. */
function headerPath(line: string): string | null {
  let s = line.slice(4).split('\t')[0]!.trim();
  if (s.startsWith('a/') || s.startsWith('b/')) s = s.slice(2);
  return s === '/dev/null' ? null : s;
}

const GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@(?:\s.*)?$/;

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USection[] = [];
  let cur: USection | null = null;
  const fresh = (): USection => ({
    gitOld: null,
    gitNew: null,
    pairOld: undefined,
    pairNew: undefined,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    delFile: false,
    hunks: [],
  });
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.gitOld = m[1]!;
      cur.gitNew = m[2]!;
      secs.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i += 1;
      const entries: BodyEntry[] = [];
      const rawEmpty: boolean[] = [];
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          entries.push({ kind: 'ctx', text: '', noeol: false });
          rawEmpty.push(true);
          i += 1;
          continue;
        }
        const c = b[0]!;
        if (c === ' ' || c === '-' || c === '+') {
          entries.push({ kind: c === ' ' ? 'ctx' : c === '-' ? 'old' : 'new', text: b.slice(1), noeol: false });
          rawEmpty.push(false);
          i += 1;
        } else if (c === '\\') {
          if (entries.length > 0) entries[entries.length - 1]!.noeol = true;
          i += 1;
        } else break;
      }
      while (entries.length > 0 && rawEmpty[rawEmpty.length - 1]) {
        entries.pop();
        rawEmpty.pop();
      }
      cur.hunks.push({ a, entries });
      continue;
    }
    if (line.startsWith('--- ')) {
      const followed = (lines[i + 1] ?? '').startsWith('+++ ');
      if (cur !== null && cur.hunks.length === 0) {
        if (!followed) throw new Exit2(`error: parse ${i + 2}`);
        if (cur.pairOld !== undefined) {
          cur = fresh();
          secs.push(cur);
        }
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      if (followed) {
        cur = fresh();
        secs.push(cur);
        cur.pairOld = headerPath(line);
        cur.pairNew = headerPath(lines[i + 1]!);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).split('\t')[0]!.trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).split('\t')[0]!.trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return secs.map((s) => unifiedEdit(s, strict));
}

function unifiedEdit(s: USection, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (s.pairOld !== undefined) {
    oldP = s.pairOld;
    newP = s.pairNew!;
  } else {
    oldP = s.renameFrom ?? s.gitOld;
    newP = s.renameTo ?? s.gitNew;
  }
  if ((oldP === null || s.newFile) && newP !== null) {
    const target = newP;
    const plus: BodyEntry[] = [];
    for (const h of s.hunks) for (const e of h.entries) if (e.kind === 'new') plus.push(e);
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const eol = !(plus.length > 0 && plus[plus.length - 1]!.noeol);
      tree.now.set(target, createdText(plus.map((e) => e.text), eol));
    };
  }
  if ((newP === null || s.delFile) && oldP !== null) {
    const target = oldP;
    return (tree) => {
      if (!safe(target)) throw new Fail('unsafe', target);
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
    };
  }
  const from = oldP ?? newP!;
  const to = newP ?? oldP!;
  const isMove = from !== to;
  return (tree) => {
    if (!safe(from)) throw new Fail('unsafe', from);
    if (isMove && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (isMove && tree.get(to) !== null) throw new Fail('exists', to);
    const model = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const { o, n, lastN } = bodyON(h.entries);
      const noBreak = lastN !== null && lastN.noeol;
      if (o.length === 0) {
        const at = Math.max(0, Math.min(h.a + d, model.lines.length));
        const wasEnd = at === model.lines.length;
        const added = n.map((x) => x.text);
        model.lines = [...model.lines.slice(0, at), ...added, ...model.lines.slice(at)];
        // The end-of-file break rule speaks of an insertion at the end; a hunk
        // that inserts nothing has no last `+` line and leaves the break alone.
        if (wasEnd && added.length > 0) model.eol = !noBreak;
        d += added.length;
      } else {
        const hit = findTier(model.lines, o, strict);
        if (hit === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let best = hit.at[0]!;
        let bestDist = Math.abs(best - target);
        for (const pos of hit.at) {
          const dist = Math.abs(pos - target);
          if (dist < bestDist) {
            best = pos;
            bestDist = dist;
          }
        }
        const runsToEnd = best + o.length === model.lines.length;
        model.lines = spliceLines(model.lines, best, o, n, hit.tier);
        if (runsToEnd) model.eol = !noBreak;
        d += n.length - o.length;
      }
    }
    const out = joinFile(model);
    if (isMove) {
      tree.now.set(from, null);
      tree.now.set(to, out);
      tree.moves.push({ from, to });
    } else {
      tree.now.set(to, out);
    }
  };
}

// --- Section 7: SEARCH/REPLACE blocks ---------------------------------------

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const sLine = i;
    let m = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        m = j;
        break;
      }
    }
    let e = -1;
    if (m >= 0) {
      for (let j = m + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          e = j;
          break;
        }
      }
    }
    if (m < 0 || e < 0) throw new Exit2(`error: parse ${sLine + 1}`);
    let path: string | null = null;
    for (let j = sLine - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${sLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(sLine + 1, m), lines.slice(m + 1, e), strict));
    prevPath = path;
    prevEnd = e;
    i = e + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, createdText(newLines, true));
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = splitFile(before);
    const hit = findTier(model.lines, oldLines, strict);
    if (hit === null) throw new Fail('no-match', path);
    if (hit.at.length > 1) throw new Fail('ambiguous', path);
    const n: NLine[] = newLines.map((t) => ({ text: t, ctxAt: -1 }));
    model.lines = spliceLines(model.lines, hit.at[0]!, oldLines, n, hit.tier);
    tree.now.set(path, joinFile(model));
  };
}

// --- Section 8: V4A patches --------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: BodyEntry[];
}

const ADD_HEAD = '*** Add File: ';
const DEL_HEAD = '*** Delete File: ';
const UPD_HEAD = '*** Update File: ';
const MOVE_HEAD = '*** Move to: ';

function v4aHead(line: string): 'add' | 'del' | 'upd' | null {
  if (line.startsWith(ADD_HEAD)) return 'add';
  if (line.startsWith(DEL_HEAD)) return 'del';
  if (line.startsWith(UPD_HEAD)) return 'upd';
  return null;
}

interface ContentLine {
  text: string;
  no: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = v4aHead(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headLine = i + 1;
    const prefix = kind === 'add' ? ADD_HEAD : kind === 'del' ? DEL_HEAD : UPD_HEAD;
    const path = line.slice(prefix.length).trim();
    i += 1;
    const content: ContentLine[] = [];
    while (i < last && v4aHead(lines[i]!) === null) {
      content.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') edits.push(v4aAdd(path, content));
    else if (kind === 'del') edits.push(v4aDelete(path, content));
    else edits.push(v4aUpdate(path, headLine, content, strict));
  }
  return edits;
}

function v4aAdd(path: string, content: ContentLine[]): Edit {
  const fileLines: string[] = [];
  for (const c of content) {
    if (c.text.startsWith('+')) fileLines.push(c.text.slice(1));
    else if (c.text === '') fileLines.push('');
    else throw new Exit2(`error: parse ${c.no}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, createdText(fileLines, true));
  };
}

function v4aDelete(path: string, content: ContentLine[]): Edit {
  for (const c of content) {
    if (!blank(c.text)) throw new Exit2(`error: parse ${c.no}`);
  }
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdate(path: string, headLine: number, content: ContentLine[], strict: boolean): Edit {
  let moveTo: string | null = null;
  let idx = 0;
  if (content.length > 0 && content[0]!.text.startsWith(MOVE_HEAD)) {
    moveTo = content[0]!.text.slice(MOVE_HEAD.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (let k = idx; k < content.length; k += 1) {
    const { text, no } = content[k]!;
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
      chunks.push(cur);
      continue;
    }
    if (text.trim() === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, entries: [] };
        chunks.push(cur);
      }
      const kind: BodyEntry['kind'] = text === '' || text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'old' : 'new';
      cur.entries.push({ kind, text: text === '' ? '' : text.slice(1), noeol: false });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const hit = findTier(model.lines, [ch.anchor], strict, cursor);
        if (hit === null) throw new Fail('no-match', path);
        cursor = hit.at[0]! + 1;
      }
      const { o, n } = bodyON(ch.entries);
      if (o.length === 0) {
        const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        const added = n.map((x) => x.text);
        model.lines = [...model.lines.slice(0, at), ...added, ...model.lines.slice(at)];
        cursor = at + added.length;
      } else {
        const hit = ch.eof
          ? findTier(model.lines, o, strict, cursor, (pos) => pos + o.length === model.lines.length)
          : findTier(model.lines, o, strict, cursor);
        if (hit === null) throw new Fail('no-match', path);
        const pos = hit.at[0]!;
        model.lines = spliceLines(model.lines, pos, o, n, hit.tier);
        cursor = pos + n.length;
      }
    }
    const out = joinFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ from: path, to: moveTo });
    } else {
      tree.now.set(path, out);
    }
  };
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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    if (tree.original(p) !== tree.now.get(p)!) changed.push(p);
  }
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  // Section 2: a successful move whose old path is gone and whose new path is
  // new replaces that pair's D and A lines with one R line, sorted by <new>.
  const paired = new Set<string>();
  const keyed: { key: string; line: string }[] = [];
  for (const mv of tree.moves) {
    if (paired.has(mv.from) || paired.has(mv.to)) continue;
    if (tree.original(mv.from) === null || tree.get(mv.from) !== null) continue;
    if (tree.original(mv.to) !== null || tree.get(mv.to) === null) continue;
    paired.add(mv.from);
    paired.add(mv.to);
    keyed.push({ key: mv.to, line: `R ${mv.from} -> ${mv.to}` });
  }
  for (const p of changed) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    keyed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  keyed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = keyed.map((k) => k.line);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
