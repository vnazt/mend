// mend — one patch tool for every AI edit format. This file is our own implementation of SPEC.md,
// all of sections 1 to 10: the command line and its usage errors, the exact exit codes and output
// lines, the safe-path and line-break bookkeeping, format detection, the three-tier line matcher,
// and the readers for unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls,
// applied in patch order with all-or-nothing writes. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file
// hands over to runner.ts (the last lines below): that hand-over and runner.ts stay as the kit
// shipped them; everything above them is the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: exactly one line of output, nothing written. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: the code and the path the failure concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** Section 3: a patch's lines — split at \n, one trailing \r removed from each, no empty last piece. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a safe path — non-empty, no leading /, no backslash, no empty, . or .. segment. */
function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const trimTrailWS = (s: string): string => s.replace(/[ \t]+$/, '');
const trimLeadWS = (s: string): string => s.replace(/^[ \t]+/, '');
const trimBothWS = (s: string): string => trimLeadWS(trimTrailWS(s));
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0];

/** A file as lines: its own break, its lines, and whether it ends with a break (section 3). */
interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function writeFileModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/**
 * The tree as the edits leave it. `original` reads a path's bytes before the patch (null: it did
 * not exist); `now` holds every path an edit has touched (null: deleted). Edits read through
 * `get`, so a later edit sees exactly what the earlier ones left (section 10).
 */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
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

/** What an edit runs against: the tree, and the moves that succeeded (for the R lines, section 2). */
interface Ctx {
  tree: Tree;
  moves: [string, string][];
}

type Edit = (ctx: Ctx) => void;

/** One body line of a unified hunk or a V4A chunk: context, old-only, or new-only. */
interface Entry {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

/** Section 5: does file line a equal patch line b at this tier? Only spaces and tabs are trimmed. */
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrailWS(a) === trimTrailWS(b);
  return trimBothWS(a) === trimBothWS(b);
}

/** Every position at which O occurs in lines at this tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  const k = o.length;
  if (k === 0) return out;
  for (let i = 0; i + k <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < k; j += 1) {
      if (!tierEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, and its occurrences there (section 5). */
function findTier(lines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * Replace the oLen file lines at pos by a hunk's or chunk's entries. Context entries are written
 * as the file's own matched lines; at tier 2 every other new line is re-indented from the patch's
 * first old line's indent P to the file's first matched line's indent F (section 5).
 */
function spliceEntries(fileLines: string[], pos: number, oLen: number, entries: Entry[], o: string[], tier: number): string[] {
  const seg: string[] = [];
  let at = pos;
  const F = leadWS(fileLines[pos] ?? '');
  const P = leadWS(o[0] ?? '');
  for (const e of entries) {
    if (e.kind === 'ctx') {
      seg.push(fileLines[at]!);
      at += 1;
    } else if (e.kind === 'del') {
      at += 1;
    } else {
      let line = e.text;
      if (tier === 2 && line !== '' && trimBothWS(line) !== '' && line.startsWith(P)) {
        line = F + line.slice(P.length);
      }
      seg.push(line);
    }
  }
  return [...fileLines.slice(0, pos), ...seg, ...fileLines.slice(pos + oLen)];
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs. A section is one edit. Sections start at a
// `diff --git a/<X> b/<Y>` line or at a `--- ` line followed by a `+++ ` line;
// before the first hunk, header lines name the paths and the kind of edit.
// ---------------------------------------------------------------------------

interface RawEl {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
  fromEmpty: boolean;
}

interface Hunk {
  a: number;
  entries: Entry[];
  /** A `\` line follows the hunk's last context or + line. */
  bsAfterLastCtxAdd: boolean;
  /** A `\` line follows the hunk's last + line. */
  bsAfterLastAdd: boolean;
}

interface Section {
  gitOld: string | undefined;
  gitNew: string | undefined;
  minusPath: string | null | undefined;
  plusPath: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(.*?) b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isDiffGitLine(l: string): boolean {
  return l.startsWith('diff --git ') || l === 'diff --git';
}

/** The path a --- or +++ line names: after the four characters, up to a tab, spaces removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.replace(/^ +| +$/g, '');
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[start]!);
  if (m === null) throw new Exit2(`error: parse ${start + 1}`);
  const a = parseInt(m[1]!, 10);
  let i = start + 1;
  const raw: RawEl[] = [];
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    const c = l[0];
    if (l === '') raw.push({ kind: 'ctx', text: '', fromEmpty: true });
    else if (c === ' ') raw.push({ kind: 'ctx', text: l.slice(1), fromEmpty: false });
    else if (c === '-') raw.push({ kind: 'del', text: l.slice(1), fromEmpty: false });
    else if (c === '+') raw.push({ kind: 'add', text: l.slice(1), fromEmpty: false });
    else if (c === '\\') raw.push({ kind: 'bs', text: '', fromEmpty: false });
    else break;
    i += 1;
  }
  // Empty lines at the end of a body are not part of it.
  while (raw.length > 0) {
    const last = raw[raw.length - 1]!;
    if (last.kind === 'ctx' && last.fromEmpty) raw.pop();
    else break;
  }
  const entries: Entry[] = [];
  for (const e of raw) {
    if (e.kind !== 'bs') entries.push({ kind: e.kind, text: e.text });
  }
  const after = (kinds: string[]): boolean => {
    for (let j = raw.length - 1; j >= 0; j -= 1) {
      if (kinds.includes(raw[j]!.kind)) return raw[j + 1]?.kind === 'bs';
    }
    return false;
  };
  return { hunk: { a, entries, bsAfterLastCtxAdd: after(['ctx', 'add']), bsAfterLastAdd: after(['add']) }, next: i };
}

/** Read a section's header and hunks, starting at index i; returns the index after the section. */
function parseSectionBody(lines: string[], i: number, sec: Section): number {
  const n = lines.length;
  let inHunks = false;
  while (i < n) {
    const line = lines[i]!;
    if (!inHunks) {
      if (isDiffGitLine(line)) return i;
      if (line.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          sec.minusPath = headerPath(line);
          sec.plusPath = headerPath(lines[i + 1]!);
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (line.startsWith('@@')) {
        inHunks = true;
        continue;
      }
      if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length);
        i += 1;
        continue;
      }
      if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length);
        i += 1;
        continue;
      }
      if (line.startsWith('new file mode')) {
        sec.newFile = true;
        i += 1;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        sec.deletedFile = true;
        i += 1;
        continue;
      }
      i += 1; // index, mode and any other header line: ignored
      continue;
    }
    if (isDiffGitLine(line)) return i;
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return i;
    if (line.startsWith('@@')) {
      const { hunk, next } = parseHunk(lines, i);
      sec.hunks.push(hunk);
      i = next;
      continue;
    }
    i += 1; // prose between hunks: ignored
  }
  return i;
}

/** Apply a section's hunks in order to a file model; d tracks the line drift (section 6). */
function applyHunks(model: FileModel, sec: Section, strict: boolean, path: string): void {
  let d = 0;
  for (const h of sec.hunks) {
    const o: string[] = [];
    let nLen = 0;
    for (const e of h.entries) {
      if (e.kind !== 'add') o.push(e.text);
      if (e.kind !== 'del') nLen += 1;
    }
    if (o.length === 0) {
      const adds = h.entries.filter((e) => e.kind === 'add').map((e) => e.text);
      const pos = Math.min(h.a + d, model.lines.length);
      const atEnd = pos === model.lines.length;
      model.lines.splice(pos, 0, ...adds);
      if (atEnd && adds.length > 0) model.final = !h.bsAfterLastCtxAdd;
      d += adds.length;
      continue;
    }
    const found = findTier(model.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const runsToEnd = best + o.length === model.lines.length;
    model.lines = spliceEntries(model.lines, best, o.length, h.entries, o, found.tier);
    if (runsToEnd) model.final = !h.bsAfterLastCtxAdd;
    d += nLen - o.length;
  }
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  let oldP: string | null;
  let newP: string | null;
  if (sec.minusPath !== undefined || sec.plusPath !== undefined) {
    oldP = sec.minusPath ?? null;
    newP = sec.plusPath ?? null;
  } else if (sec.renameFrom !== undefined && sec.renameTo !== undefined) {
    oldP = sec.renameFrom;
    newP = sec.renameTo;
  } else {
    oldP = sec.gitOld ?? null;
    newP = sec.gitNew ?? null;
  }
  const isCreate = oldP === null || sec.newFile;
  const isDelete = !isCreate && (newP === null || sec.deletedFile);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (ctx) => {
    const { tree } = ctx;
    if (isCreate) {
      const target = newP ?? oldP;
      if (target === null) throw new Exit2('error: parse 1');
      if (!safePath(target)) throw new Fail('unsafe', target);
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const out: string[] = [];
      for (const h of sec.hunks) {
        for (const e of h.entries) if (e.kind === 'add') out.push(e.text);
      }
      let final = true;
      for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        if (sec.hunks[hi]!.entries.some((e) => e.kind === 'add')) {
          final = !sec.hunks[hi]!.bsAfterLastAdd;
          break;
        }
      }
      tree.now.set(target, out.length === 0 ? '' : out.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (oldP === null) throw new Exit2('error: parse 1');
    if (!safePath(oldP)) throw new Fail('unsafe', oldP);
    if (isDelete) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (isMove && newP !== null && !safePath(newP)) throw new Fail('unsafe', newP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    if (isMove && newP !== null && tree.get(newP) !== null) throw new Fail('exists', newP);
    const model = parseFile(before);
    applyHunks(model, sec, strict, oldP);
    const text = writeFileModel(model);
    if (isMove && newP !== null) {
      tree.now.set(newP, text);
      tree.now.set(oldP, null);
      ctx.moves.push([oldP, newP]);
    } else {
      tree.now.set(oldP, text);
    }
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isDiffGitLine(line)) {
      const m = DIFF_GIT_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        gitOld: m[1]!,
        gitNew: m[2]!,
        minusPath: undefined,
        plusPath: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i = parseSectionBody(lines, i + 1, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const sec: Section = {
        gitOld: undefined,
        gitNew: undefined,
        minusPath: undefined,
        plusPath: undefined,
        renameFrom: undefined,
        renameTo: undefined,
        newFile: false,
        deletedFile: false,
        hunks: [],
      };
      i = parseSectionBody(lines, i, sec);
      edits.push(unifiedEdit(sec, strict));
    } else if (line.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`); // a hunk before any section
    } else {
      i += 1; // prose and code fences outside sections: ignored
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks. The path is the nearest usable line
// before the SEARCH marker, or the previous block's path when there is none.
// ---------------------------------------------------------------------------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (ctx) => {
    const { tree } = ctx;
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = findTier(model.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const entries: Entry[] = newLines.map((t) => ({ kind: 'add', text: t }));
    model.lines = spliceEntries(model.lines, found.occ[0]!, oldLines.length, entries, oldLines, found.tier);
    tree.now.set(path, writeFileModel(model));
  };
}

function parseSR(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let prevEnd = 0; // the index just after the previous block's REPLACE line
  let lastPath: string | null = null;
  let i = 0;
  while (i < n) {
    if (trimTrailWS(lines[i]!) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNo = i + 1;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j -= 1) {
      const l = lines[j]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (lastPath !== null) path = lastPath;
      else throw new Exit2(`error: parse ${searchNo}`);
    }
    let eq = -1;
    for (let j = i + 1; j < n; j += 1) {
      if (trimTrailWS(lines[j]!) === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchNo}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j += 1) {
      if (trimTrailWS(lines[j]!) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchNo}`);
    edits.push(srEdit(path, lines.slice(i + 1, eq), lines.slice(eq + 1, rep), strict));
    lastPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches. Sections are Add File, Delete File and Update File;
// an Update File holds chunks found with a cursor, optionally anchored.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

interface BodyLine {
  text: string;
  no: number;
}

function v4aHeader(line: string): { kind: 'add' | 'del' | 'upd'; path: string } | null {
  if (line.startsWith('*** Add File:')) return { kind: 'add', path: trimBothWS(line.slice('*** Add File:'.length)) };
  if (line.startsWith('*** Delete File:')) return { kind: 'del', path: trimBothWS(line.slice('*** Delete File:'.length)) };
  if (line.startsWith('*** Update File:')) return { kind: 'upd', path: trimBothWS(line.slice('*** Update File:'.length)) };
  return null;
}

/** The first occurrence of O at or after `from`, at the first tier with one (section 8). */
function findChunk(lines: string[], o: string[], strict: boolean, from: number, eofOnly: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t).filter((p) => p >= from && (!eofOnly || p + o.length === lines.length));
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

function v4aEdit(kind: 'add' | 'del' | 'upd', path: string, headerNo: number, body: BodyLine[], strict: boolean): Edit {
  // Blank lines at the end of a section are not part of it (a blank line is
  // empty or only whitespace, as section 4 defines it).
  while (body.length > 0 && body[body.length - 1]!.text.trim() === '') body.pop();
  if (kind === 'add') {
    const fileLines: string[] = [];
    for (const bl of body) {
      if (bl.text.startsWith('+')) fileLines.push(bl.text.slice(1));
      else if (bl.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${bl.no}`);
    }
    return (ctx) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (ctx.tree.get(path) !== null) throw new Fail('exists', path);
      ctx.tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
    };
  }
  if (kind === 'del') {
    for (const bl of body) {
      if (bl.text.trim() !== '') throw new Exit2(`error: parse ${bl.no}`);
    }
    return (ctx) => {
      if (!safePath(path)) throw new Fail('unsafe', path);
      if (ctx.tree.get(path) === null) throw new Fail('missing', path);
      ctx.tree.now.set(path, null);
    };
  }
  // Update File: an optional Move to as its first line, then chunks.
  let moveTo: string | null = null;
  let start = 0;
  if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
    moveTo = trimBothWS(body[0]!.text.slice('*** Move to:'.length));
    start = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let started = false;
  for (let k = start; k < body.length; k += 1) {
    const { text: l, no } = body[k]!;
    if (l.startsWith('@@')) {
      const anchor = trimBothWS(l.slice(2));
      cur = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
      chunks.push(cur);
      started = true;
      continue;
    }
    if (trimTrailWS(l) === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      cur = null;
      continue;
    }
    if (l.startsWith('*** Move to:')) throw new Exit2(`error: parse ${no}`);
    const c = l[0];
    if (l === '' || c === ' ' || c === '-' || c === '+') {
      if (cur === null) {
        if (started) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, eof: false, entries: [] };
        chunks.push(cur);
        started = true;
      }
      if (l === '') cur.entries.push({ kind: 'ctx', text: '' });
      else if (c === ' ') cur.entries.push({ kind: 'ctx', text: l.slice(1) });
      else if (c === '-') cur.entries.push({ kind: 'del', text: l.slice(1) });
      else cur.entries.push({ kind: 'add', text: l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (ctx) => {
    const { tree } = ctx;
    if (!safePath(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safePath(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const tiers = strict ? [0] : [0, 1, 2];
        let foundAt = -1;
        for (const t of tiers) {
          for (let idx = cursor; idx < model.lines.length; idx += 1) {
            if (tierEq(model.lines[idx]!, ch.anchor, t)) {
              foundAt = idx;
              break;
            }
          }
          if (foundAt >= 0) break;
        }
        if (foundAt < 0) throw new Fail('no-match', path);
        cursor = foundAt + 1;
      }
      const o: string[] = [];
      let nLen = 0;
      for (const e of ch.entries) {
        if (e.kind !== 'add') o.push(e.text);
        if (e.kind !== 'del') nLen += 1;
      }
      if (o.length === 0) {
        const adds = ch.entries.filter((e) => e.kind === 'add').map((e) => e.text);
        const pos = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(pos, 0, ...adds);
        cursor = pos + adds.length;
        continue;
      }
      const found = findChunk(model.lines, o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      model.lines = spliceEntries(model.lines, found.pos, o.length, ch.entries, o, found.tier);
      cursor = found.pos + nLen;
    }
    const text = writeFileModel(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, text);
      tree.now.set(path, null);
      ctx.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const firstNB = lines.findIndex((l) => l.trim() !== '');
  if (firstNB < 0) throw new Exit2('error: parse 1');
  if (lines[firstNB]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${firstNB + 1}`);
  let lastNB = -1;
  for (let j = n - 1; j >= 0; j -= 1) {
    if (lines[j]!.trim() !== '') {
      lastNB = j;
      break;
    }
  }
  if (lines[lastNB]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = firstNB + 1;
  while (i < lastNB) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const h = v4aHeader(line);
    if (h === null) throw new Exit2(`error: parse ${i + 1}`);
    const headerNo = i + 1;
    i += 1;
    const body: BodyLine[] = [];
    while (i < lastNB && v4aHeader(lines[i]!) === null) {
      body.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    edits.push(v4aEdit(h.kind, h.path, headerNo, body, strict));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits — one array of edit objects, or one object a line.
// A wrong command or a missing or mistyped key is a parse fault.
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (ctx: Ctx): string => {
    if (!safePath(p)) throw new Fail('unsafe', p);
    const t = ctx.tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (ctx) => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (ctx.tree.get(p) !== null) throw new Fail('exists', p);
      ctx.tree.now.set(p, text); // a JSON create writes its file_text byte for byte
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (ctx) => {
      const before = existing(ctx);
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
      ctx.tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (ctx) => {
      const before = existing(ctx);
      const model = parseFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      ctx.tree.now.set(p, writeFileModel(model)); // the file's final break stays as it was
    };
  }
  return null;
}

function parseJSON(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
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
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${idx + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format — the first of four rules that holds.
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimTrailWS(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Sections 1, 2 and 10: the command line, the run, the all-or-nothing write.
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
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
        ? parseJSON(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSR(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const ctx: Ctx = { tree, moves: [] };
  const fails: Fail[] = [];
  for (const edit of edits) {
    const snap = new Map(tree.now);
    const movesBefore = ctx.moves.length;
    try {
      edit(ctx);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of snap) tree.now.set(k, v);
      ctx.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Exit 0: one line per changed path in byte order; a successful move whose
  // old path is gone and whose new path is new replaces its D and A lines by
  // one R line, sorted by the new path (section 2).
  const rows: { key: string; text: string }[] = [];
  const consumed = new Set<string>();
  for (const [oldP, newP] of ctx.moves) {
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null && tree.now.get(newP) !== undefined) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of tree.now.keys()) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key, 'utf8'), Buffer.from(y.key, 'utf8')));
  if (!check) {
    for (const p of tree.now.keys()) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
