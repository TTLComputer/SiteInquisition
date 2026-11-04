/**
 * A small YAML reader, enough for OpenAPI and Swagger files: block mappings
 * and sequences, flow collections ([a, b], {a: 1}), plain, single and double
 * quoted scalars, block scalars (| and >, with - and + chomping), comments,
 * anchors and aliases (&a / *a), merge keys (<<: *a) and a leading
 * document marker. Tags (!!str) are ignored. It does not try to be a full
 * YAML 1.2 implementation; unsupported input fails with a line number.
 */
export class YamlError extends Error {
  constructor(msg: string, readonly line: number) {
    super(`YAML line ${line}: ${msg}`);
  }
}

interface Line {
  n: number;
  indent: number;
  text: string;
}

const NUM = /^[-+]?(\d[\d_]*)?(\.\d+)?([eE][-+]?\d+)?$/;

function scalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return parseInt(s, 16);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?\.inf$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (/^\.nan$/i.test(s)) return NaN;
  if (NUM.test(s) && /\d/.test(s)) {
    // Keep long digit strings (ids, phone numbers) and leading zeros as text.
    if (/^[-+]?0\d/.test(s) || s.replace(/[^\d]/g, '').length > 15) return s;
    return Number(s.replace(/_/g, ''));
  }
  return s;
}

function unquoteDouble(s: string, line: number): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[++i];
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0', b: '\b', f: '\f', ' ': ' ', e: '\x1b', a: '\x07', v: '\v', N: '\u0085', _: ' ' };
    if (e === undefined) throw new YamlError('dangling escape', line);
    if (map[e] !== undefined) out += map[e];
    else if (e === 'x' || e === 'u' || e === 'U') {
      const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const hex = s.slice(i + 1, i + 1 + len);
      const cp = /^[0-9a-f]+$/i.test(hex) && hex.length === len ? parseInt(hex, 16) : NaN;
      if (!(cp <= 0x10ffff)) throw new YamlError(`invalid \\${e} escape "\\${e}${hex}"`, line);
      out += String.fromCodePoint(cp);
      i += len;
    } else out += e;
  }
  return out;
}

/** Remove a trailing comment that is not inside quotes. */
function stripComment(s: string): string {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else q = null;
      } else if (c === '\\' && q === '"') i++;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1]!)) q = c;
    } else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).replace(/\s+$/, '');
  }
  return s.replace(/\s+$/, '');
}

/** Index of the `: ` that separates a key from its value, outside quotes and brackets; -1 if none. */
function keySep(s: string): number {
  let q: string | null = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"') i++;
      continue;
    }
    if ((c === '"' || c === "'") && (i === 0 || /[\s[{,]/.test(s[i - 1]!))) q = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === ':' && depth === 0 && (i === s.length - 1 || s[i + 1] === ' ' || s[i + 1] === '\t')) return i;
  }
  return -1;
}

class Parser {
  private lines: Line[] = [];
  private i = 0;
  private anchors = new Map<string, unknown>();

  constructor(text: string) {
    const raw = text.replace(/^﻿/, '').split(/\r?\n/);
    for (let n = 0; n < raw.length; n++) {
      const l = raw[n]!;
      if (/^\s*$/.test(l)) {
        this.lines.push({ n: n + 1, indent: -1, text: '' });
        continue;
      }
      if (/^\t/.test(l)) throw new YamlError('tabs cannot be used for indentation', n + 1);
      const indent = l.length - l.trimStart().length;
      this.lines.push({ n: n + 1, indent, text: l.slice(indent) });
    }
  }

  /** Next line with content, skipping blanks and comment-only lines. */
  private peek(): Line | undefined {
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (l.indent >= 0 && !l.text.startsWith('#')) {
        if (l.indent === 0 && /^(---|\.\.\.)(\s|$)/.test(l.text)) {
          const rest = l.text.slice(3).trim();
          if (rest && !rest.startsWith('#')) {
            // "--- value" on the marker line
            l.text = rest;
            return l;
          }
          this.i++;
          continue;
        }
        if (l.text.startsWith('%')) {
          this.i++;
          continue;
        }
        return l;
      }
      this.i++;
    }
    return undefined;
  }

  parse(): unknown {
    const first = this.peek();
    if (!first) return null;
    const v = this.node(first.indent);
    const extra = this.peek();
    if (extra) throw new YamlError('unexpected content after the document (multiple documents are not supported)', extra.n);
    return v;
  }

  /** Parse the node whose first line is at `indent`. */
  private node(indent: number): unknown {
    const l = this.peek();
    if (!l || l.indent < indent) return null;
    if (l.text === '-' || l.text.startsWith('- ')) return this.seq(l.indent);
    if (keySep(stripComment(l.text)) !== -1 || /^\?\s/.test(l.text)) return this.map(l.indent);
    // A scalar or flow node, possibly spread over several lines.
    this.i++;
    return this.inline(this.continuation(stripComment(l.text), l.indent), l.n);
  }

  /** Join the following more-indented lines of a multi-line plain or flow scalar. */
  private continuation(start: string, indent: number): string {
    let s = start;
    const open = () => {
      let d = 0;
      let q: string | null = null;
      for (let k = 0; k < s.length; k++) {
        const c = s[k]!;
        if (q) {
          if (c === q) q = null;
          else if (c === '\\' && q === '"') k++;
        } else if (c === '"' || c === "'") q = c;
        else if (c === '[' || c === '{') d++;
        else if (c === ']' || c === '}') d--;
      }
      return d > 0 || q !== null;
    };
    while (this.i < this.lines.length) {
      const nx = this.lines[this.i]!;
      if (nx.indent === -1) {
        if (!open()) {
          // a blank line inside a plain scalar folds to a newline; look ahead
          let k = this.i;
          while (k < this.lines.length && this.lines[k]!.indent === -1) k++;
          const after = this.lines[k];
          if (!after || after.indent <= indent || after.text.startsWith('#')) break;
          s += '\n';
          this.i = k;
          continue;
        }
        this.i++;
        continue;
      }
      if (!open() && (nx.indent <= indent || nx.text.startsWith('#'))) break;
      if (!open() && (keySep(stripComment(nx.text)) !== -1 || nx.text.startsWith('- '))) break;
      s += (s.endsWith('\n') ? '' : ' ') + stripComment(nx.text);
      this.i++;
    }
    return s;
  }

  private seq(indent: number): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent || !(l.text === '-' || l.text.startsWith('- '))) {
        if (l && l.indent > indent) throw new YamlError('bad indentation in a list', l.n);
        break;
      }
      const rest = l.text.slice(1).replace(/^ +/, '');
      if (!rest || rest.startsWith('#')) {
        this.i++;
        const nx = this.peek();
        out.push(nx && nx.indent > indent ? this.node(nx.indent) : null);
        continue;
      }
      // "- key: value" or "- - x" opens a nested block at the item's column.
      const col = indent + (l.text.length - rest.length);
      l.indent = col;
      l.text = rest;
      out.push(this.item(col));
    }
    return out;
  }

  /** A sequence item or mapping value that starts on the same line as its marker. */
  private item(col: number): unknown {
    const l = this.peek()!;
    const { text } = l;
    const anchor = /^&([^\s]+)\s*(.*)$/.exec(text);
    if (anchor) {
      l.text = anchor[2]!;
      if (!l.text || l.text.startsWith('#')) {
        this.i++;
        const nx = this.peek();
        const v = nx && nx.indent > col - 1 ? this.node(nx.indent) : null;
        this.anchors.set(anchor[1]!, v);
        return v;
      }
      const v = this.item(col);
      this.anchors.set(anchor[1]!, v);
      return v;
    }
    if (text === '-' || text.startsWith('- ')) return this.seq(col);
    // "- key: value" (the key may be quoted); a flow collection is not a key.
    if (keySep(stripComment(text)) !== -1 && !/^[[{]/.test(text.trim())) return this.map(col);
    this.i++;
    const t = stripComment(text);
    if (/^[|>]/.test(t)) return this.block(t, col - 1, l.n);
    return this.inline(this.continuation(t, col - 1), l.n);
  }

  private map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (;;) {
      const l = this.peek();
      if (!l || l.indent !== indent) {
        if (l && l.indent > indent) throw new YamlError('bad indentation', l.n);
        break;
      }
      if (l.text === '-' || l.text.startsWith('- ')) break;
      const t = stripComment(l.text);
      const at = keySep(t);
      if (at === -1) throw new YamlError(`expected "key: value", got "${t.slice(0, 40)}"`, l.n);
      const key = String(this.inline(t.slice(0, at).trim(), l.n));
      const rest = t.slice(at + 1).trim();
      let value: unknown;
      if (!rest) {
        this.i++;
        const nx = this.peek();
        if (nx && (nx.indent > indent || (nx.indent === indent && (nx.text === '-' || nx.text.startsWith('- '))))) value = this.node(nx.indent);
        else value = null;
      } else {
        value = this.value(rest, indent, l);
      }
      if (key === '<<') {
        const src = Array.isArray(value) ? value : [value];
        for (const s of src) if (s && typeof s === 'object') for (const [k, v] of Object.entries(s)) if (!(k in out)) out[k] = v;
      } else out[key] = value;
    }
    return out;
  }

  /** The value after "key: " on the same line. */
  private value(rest: string, indent: number, l: Line): unknown {
    const anchor = /^&([^\s]+)\s*(.*)$/.exec(rest);
    if (anchor) {
      const inner = anchor[2]!;
      let v: unknown;
      if (!inner) {
        this.i++;
        const nx = this.peek();
        v = nx && (nx.indent > indent || (nx.indent === indent && nx.text.startsWith('- '))) ? this.node(nx.indent) : null;
      } else v = this.value(inner, indent, l);
      this.anchors.set(anchor[1]!, v);
      return v;
    }
    const tag = /^!!?[\w/:.-]*\s+(.*)$/.exec(rest);
    if (tag) return this.value(tag[1]!, indent, l);
    this.i++;
    if (/^[|>]/.test(rest)) return this.block(rest, indent, l.n);
    return this.inline(this.continuation(rest, indent), l.n);
  }

  /** A literal (|) or folded (>) block scalar. */
  private block(header: string, parentIndent: number, n: number): string {
    const m = /^([|>])([+-]?)(\d?)([+-]?)\s*$/.exec(header);
    if (!m) throw new YamlError(`bad block scalar header "${header}"`, n);
    const folded = m[1] === '>';
    const chomp = m[2] || m[4] || '';
    const explicit = m[3] ? Number(m[3]) : 0;
    const body: Array<string | null> = [];
    let blockIndent = explicit ? parentIndent + explicit : -1;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (l.indent === -1) {
        body.push(null);
        this.i++;
        continue;
      }
      if (blockIndent === -1) {
        if (l.indent <= parentIndent) break;
        blockIndent = l.indent;
      }
      if (l.indent < blockIndent) break;
      body.push(' '.repeat(l.indent - blockIndent) + l.text);
      this.i++;
    }
    // Trailing blank lines belong to chomping, not content.
    let trailing = 0;
    while (body.length && body[body.length - 1] === null) (body.pop(), trailing++);
    let text: string;
    if (!folded) text = body.map((x) => x ?? '').join('\n');
    else {
      text = '';
      for (let k = 0; k < body.length; k++) {
        const cur = body[k] ?? null;
        if (cur === null) {
          text += '\n';
          continue;
        }
        const prev = body[k - 1];
        if (k > 0 && prev !== null && prev !== undefined && !/^\s/.test(cur) && !/^\s/.test(prev)) text += ' ';
        else if (k > 0 && prev !== null) text += '\n';
        text += cur;
      }
    }
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n'.repeat(trailing + 1);
    return body.length ? `${text}\n` : '';
  }

  /** A scalar, alias or flow collection written on one (joined) line. */
  private inline(s: string, n: number): unknown {
    const t = s.trim();
    if (t.startsWith('*')) {
      const name = t.slice(1);
      if (!this.anchors.has(name)) throw new YamlError(`unknown alias *${name}`, n);
      return this.anchors.get(name);
    }
    if (/^!!?[\w/:.-]*\s+/.test(t)) return this.inline(t.replace(/^!!?[\w/:.-]*\s+/, ''), n);
    if (t.startsWith('[') || t.startsWith('{')) {
      const f = new Flow(t, n, this.anchors);
      const v = f.value();
      f.end();
      return v;
    }
    if (t.startsWith('"')) {
      if (!t.endsWith('"') || t.length < 2) throw new YamlError('unterminated double-quoted string', n);
      return unquoteDouble(t.slice(1, -1).replace(/\\\n\s*/g, '').replace(/[ \t]*\n[ \t]*/g, ' '), n);
    }
    if (t.startsWith("'")) {
      if (!t.endsWith("'") || t.length < 2) throw new YamlError('unterminated single-quoted string', n);
      return t.slice(1, -1).replace(/''/g, "'").replace(/[ \t]*\n[ \t]*/g, ' ');
    }
    return scalar(t);
  }
}

/** Flow collections: [a, b] and {a: 1, b: [2]}. */
class Flow {
  private p = 0;
  constructor(
    private readonly s: string,
    private readonly n: number,
    private readonly anchors: Map<string, unknown>,
  ) {}
  private ws() {
    while (this.p < this.s.length && /\s/.test(this.s[this.p]!)) this.p++;
  }
  end() {
    this.ws();
    if (this.p < this.s.length) throw new YamlError(`unexpected "${this.s.slice(this.p, this.p + 20)}"`, this.n);
  }
  value(): unknown {
    this.ws();
    const c = this.s[this.p];
    if (c === '[') {
      this.p++;
      const out: unknown[] = [];
      for (;;) {
        this.ws();
        if (this.s[this.p] === ']') return (this.p++, out);
        out.push(this.value());
        this.ws();
        if (this.s[this.p] === ',') this.p++;
        else if (this.s[this.p] !== ']') throw new YamlError('expected , or ] in a flow list', this.n);
      }
    }
    if (c === '{') {
      this.p++;
      const out: Record<string, unknown> = {};
      for (;;) {
        this.ws();
        if (this.s[this.p] === '}') return (this.p++, out);
        const k = String(this.value());
        this.ws();
        let v: unknown = null;
        if (this.s[this.p] === ':') {
          this.p++;
          v = this.value();
        }
        out[k] = v;
        this.ws();
        if (this.s[this.p] === ',') this.p++;
        else if (this.s[this.p] !== '}') throw new YamlError('expected , or } in a flow mapping', this.n);
      }
    }
    if (c === '"' || c === "'") {
      let k = this.p + 1;
      let raw = '';
      for (; k < this.s.length; k++) {
        const ch = this.s[k]!;
        if (c === '"' && ch === '\\') {
          raw += ch + (this.s[k + 1] ?? '');
          k++;
          continue;
        }
        if (ch === c) {
          if (c === "'" && this.s[k + 1] === "'") {
            raw += "'";
            k++;
            continue;
          }
          break;
        }
        raw += ch;
      }
      if (k >= this.s.length) throw new YamlError('unterminated string', this.n);
      this.p = k + 1;
      return c === '"' ? unquoteDouble(raw, this.n) : raw;
    }
    // plain scalar inside a flow collection
    const start = this.p;
    while (this.p < this.s.length) {
      const ch = this.s[this.p]!;
      if (ch === ',' || ch === ']' || ch === '}') break;
      if (ch === ':' && /[\s,\]}]/.test(this.s[this.p + 1] ?? ' ')) break;
      this.p++;
    }
    const t = this.s.slice(start, this.p).trim();
    if (t.startsWith('*')) {
      if (!this.anchors.has(t.slice(1))) throw new YamlError(`unknown alias ${t}`, this.n);
      return this.anchors.get(t.slice(1));
    }
    return scalar(t);
  }
}

export function parseYaml(text: string): unknown {
  return new Parser(text).parse();
}

/** Parse JSON, falling back to YAML. */
export function parseJsonOrYaml(text: string): unknown {
  const t = text.trimStart();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.parse(t);
    } catch {
      // flow-style YAML, or JSON with comments
    }
  }
  return parseYaml(text);
}
