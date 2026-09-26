// A small, safe arithmetic evaluator for `$[…]` math in imported brews.
//
// Upstream (marked-variables) evaluates these with expr-eval, which has unpatched
// prototype-pollution / code-execution advisories. Imports are untrusted input (other people's
// brews), so this module re-implements the subset of expr-eval that upstream enables
// (marked-variables/src/index.js:10-99) with no property access, no assignment, no function
// definitions and no access to anything but the functions listed below. Unsupported syntax
// throws, which the caller treats like upstream treats an expr-eval error (the text is kept).
//
// Grammar (expr-eval 2.0.2 precedence):
//   expression  := additive ('?' expression ':' expression)?
//   additive    := term (('+' | '-') term)*
//   term        := factor (('*' | '/') factor)*
//   factor      := ('-' | '+') factor | UNARY factor | exponent        (UNARY: round floor ceil abs)
//   exponent    := call ('^' factor)*
//   call        := UNARY atom | atom ('(' arguments? ')')*
//   atom        := number | string | name | '(' expression ')'

export type MathValue = number | string | boolean;

type Fn = (...args: MathValue[]) => MathValue;

const num = (v: MathValue): number => Number(v);

// ---------------------------------------------------------------------------------------------
// Custom Homebrewery functions (marked-variables/src/index.js:45-99)
// ---------------------------------------------------------------------------------------------

const ROMAN_PAIRS: ReadonlyArray<readonly [number, string]> = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

/** Same rules as the `romans` package's romanize: integers 1–3999, otherwise throws. */
export function romanize(value: number): string {
  if (value === Infinity || value >= 4000) throw new RangeError('requires max value of less than 4000');
  if ((value | 0) !== value || value <= 0) throw new RangeError('requires an unsigned integer');
  let rest = value;
  let out = '';
  for (const [n, s] of ROMAN_PAIRS) {
    while (rest >= n) {
      out += s;
      rest -= n;
    }
  }
  return out;
}

const EN_BASE: Record<number, string> = {
  0: 'zero', 1: 'one', 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six', 7: 'seven', 8: 'eight',
  9: 'nine', 10: 'ten', 11: 'eleven', 12: 'twelve', 13: 'thirteen', 14: 'fourteen', 15: 'fifteen',
  16: 'sixteen', 17: 'seventeen', 18: 'eighteen', 19: 'nineteen', 20: 'twenty', 30: 'thirty',
  40: 'forty', 50: 'fifty', 60: 'sixty', 70: 'seventy', 80: 'eighty', 90: 'ninety',
};
const EN_UNITS = [
  'hundred', 'thousand', 'million', 'billion', 'trillion', 'quadrillion', 'quintillion', 'sextillion',
  'septillion', 'octillion', 'nonillion', 'decillion', 'undecillion', 'duodecillion', 'tredecillion',
  'quattuordecillion', 'quindecillion',
];
const EN_SCALE = [100, ...Array.from({ length: 16 }, (_, i) => Math.pow(10, (i + 1) * 3))];

/**
 * English branch of the `written-number` package (0.11.1, the default options marked-variables
 * uses): 80085 → "eighty thousand and eighty-five". Negative numbers give ''.
 */
export function writtenNumber(value: number, noAnd = false): string {
  if (value < 0) return '';
  let n = Math.round(+value);
  const base = EN_BASE[n];
  if (base !== undefined) return base;
  if (n < 100) {
    const dec = Math.floor(n / 10) * 10;
    const unit = n - dec;
    return unit ? `${EN_BASE[dec]}-${writtenNumber(unit, noAnd)}` : String(EN_BASE[dec]);
  }
  const m = n % 100;
  const ret: string[] = [];
  if (m) ret.push(noAnd ? writtenNumber(m, noAnd) : `and ${writtenNumber(m, noAnd)}`);
  for (let i = 0; i < EN_UNITS.length; i++) {
    const scale = EN_SCALE[i]!;
    const divideBy = i === EN_UNITS.length - 1 ? 1000000 : EN_SCALE[i + 1]! / scale;
    const r = Math.floor(n / scale) % divideBy;
    if (!r) continue;
    const words = writtenNumber(r, true);
    n -= r * scale;
    ret.push(`${words} ${EN_UNITS[i]}`);
  }
  return ret.reverse().join(' ');
}

function toChar(a: number): MathValue {
  if (a <= 0) return a;
  const genChars = (i: number): string =>
    (i > 26 ? genChars(Math.floor((i - 1) / 26)) : '') + String('ABCDEFGHIJKLMNOPQRSTUVWXYZ'[(i - 1) % 26]);
  return genChars(a);
}

/**
 * Upstream's callback compares the captured character (its second argument) with 0, which is
 * never true, so every match is upper-cased: "eighty-five" → "Eighty-Five".
 */
function toWordsCaps(a: number): string {
  return writtenNumber(a)
    .split(' ')
    .map((word) => word.replace(/(?:^|\b|\s)(\w)/g, (w) => w.toUpperCase()))
    .join(' ');
}

function factorial(a: number): number {
  if (!Number.isInteger(a) || a < 0) return NaN;
  // 171! is already Infinity; without this cap `fac(1e12)` would hang the import (untrusted input).
  if (a > 170) return Infinity;
  let out = 1;
  for (let i = 2; i <= a; i++) out *= i;
  return out;
}

function roundTo(value: number, exp?: number): number {
  if (exp === undefined || +exp === 0) return Math.round(value);
  const e = -exp;
  if (!(typeof e === 'number' && e % 1 === 0)) return NaN;
  const shift = (v: number, by: number) => {
    const [m, x] = v.toString().split('e');
    return +`${m}e${x ? +x + by : by}`;
  };
  return shift(Math.round(shift(value, -e)), e);
}

/** Prefix operators (`round x` or `round(x)`); expr-eval's enabled unary ops. */
const UNARY: Record<string, (a: number) => number> = {
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
  abs: Math.abs,
};

/** Callable functions: expr-eval's always-present numeric functions + the Homebrewery ones. */
const FUNCTIONS: Record<string, Fn> = {
  min: (...a) => Math.min(...a.map(num)),
  max: (...a) => Math.max(...a.map(num)),
  hypot: (...a) => Math.hypot(...a.map(num)),
  pyt: (...a) => Math.hypot(...a.map(num)),
  pow: (a = NaN, b = NaN) => Math.pow(num(a), num(b)),
  atan2: (a = NaN, b = NaN) => Math.atan2(num(a), num(b)),
  fac: (a = NaN) => factorial(num(a)),
  roundTo: (a = NaN, b) => roundTo(num(a), b === undefined ? undefined : num(b)),
  random: (a = 1) => Math.random() * (num(a) || 1),
  if: (c = false, a = NaN, b = NaN) => (c ? a : b),
  sign: (a = NaN) => (num(a) >= 0 ? '+' : '-'),
  signed: (a = NaN) => (num(a) >= 0 ? `+${String(a)}` : String(a)),
  toRomans: (a = NaN) => romanize(num(a)),
  toRomansUpper: (a = NaN) => romanize(num(a)).toUpperCase(),
  toRomansLower: (a = NaN) => romanize(num(a)).toLowerCase(),
  toChar: (a = NaN) => toChar(num(a)),
  toCharUpper: (a = NaN) => String(toChar(num(a))).toUpperCase(),
  toCharLower: (a = NaN) => String(toChar(num(a))).toLowerCase(),
  toWords: (a = NaN) => writtenNumber(num(a)),
  toWordsUpper: (a = NaN) => writtenNumber(num(a)).toUpperCase(),
  toWordsLower: (a = NaN) => writtenNumber(num(a)).toLowerCase(),
  toWordsCaps: (a = NaN) => toWordsCaps(num(a)),
};

const CONSTANTS: Record<string, MathValue> = { PI: Math.PI, E: Math.E, true: true, false: false };

const has = (table: object, key: string): boolean => Object.prototype.hasOwnProperty.call(table, key);

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'eof' };

const NUMBER = /^(?:0x[0-9a-f]+|(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i;
const NAME = /^[A-Za-z_$][\w$]*/;

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const n = NUMBER.exec(rest);
    if (n && /[\d.]/.test(ch)) {
      tokens.push({ t: 'num', v: Number(n[0]) });
      i += n[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ t: 'name', v: name[0] });
      i += name[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== ch) {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' } as Record<string, string>)[esc] ?? esc;
          j += 2;
        } else out += src[j++];
      }
      if (j >= src.length) throw new SyntaxError('unterminated string');
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if ('+-*/^(),?:'.includes(ch)) {
      tokens.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    throw new SyntaxError(`Unknown character "${ch}"`);
  }
  tokens.push({ t: 'eof' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser + evaluator (evaluates while parsing; no AST is kept)
// ---------------------------------------------------------------------------------------------

class Evaluator {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(src: string) {
    this.tokens = tokenize(src);
  }

  run(): MathValue {
    const value = this.expression();
    if (this.peek().t !== 'eof') throw new SyntaxError('Expected EOF');
    return value;
  }

  private peek(offset = 0): Token {
    return this.tokens[this.pos + offset] ?? { t: 'eof' };
  }

  private isOp(v: string, offset = 0): boolean {
    const tok = this.peek(offset);
    return tok.t === 'op' && tok.v === v;
  }

  private expect(v: string): void {
    if (!this.isOp(v)) throw new SyntaxError(`Expected ${v}`);
    this.pos++;
  }

  private expression(): MathValue {
    const cond = this.additive();
    if (!this.isOp('?')) return cond;
    this.pos++;
    const a = this.expression();
    this.expect(':');
    const b = this.expression();
    return cond ? a : b;
  }

  private additive(): MathValue {
    let left = this.term();
    while (this.isOp('+') || this.isOp('-')) {
      const op = (this.tokens[this.pos++] as { v: string }).v;
      const right = this.term();
      left = op === '+' ? num(left) + num(right) : num(left) - num(right);
    }
    return left;
  }

  private term(): MathValue {
    let left = this.factor();
    while (this.isOp('*') || this.isOp('/')) {
      const op = (this.tokens[this.pos++] as { v: string }).v;
      const right = this.factor();
      left = op === '*' ? num(left) * num(right) : num(left) / num(right);
    }
    return left;
  }

  private factor(): MathValue {
    if (this.isOp('-') || this.isOp('+')) {
      const op = (this.tokens[this.pos++] as { v: string }).v;
      const value = num(this.factor());
      return op === '-' ? -value : value;
    }
    const tok = this.peek();
    if (tok.t === 'name' && has(UNARY, tok.v) && !this.isOp('(', 1)) {
      this.pos++;
      return UNARY[tok.v]!(num(this.factor()));
    }
    return this.exponent();
  }

  private exponent(): MathValue {
    let left = this.call();
    while (this.isOp('^')) {
      this.pos++;
      left = Math.pow(num(left), num(this.factor()));
    }
    return left;
  }

  private call(): MathValue {
    const tok = this.peek();
    if (tok.t === 'name' && has(UNARY, tok.v)) {
      // `round(x)`: a prefix operator applied to a parenthesized atom.
      this.pos++;
      return UNARY[tok.v]!(num(this.atom()));
    }
    if (tok.t === 'name' && has(FUNCTIONS, tok.v)) {
      this.pos++;
      if (!this.isOp('(')) throw new SyntaxError(`${tok.v} is a function`);
      this.pos++;
      const args: MathValue[] = [];
      if (!this.isOp(')')) {
        args.push(this.expression());
        while (this.isOp(',')) {
          this.pos++;
          args.push(this.expression());
        }
      }
      this.expect(')');
      return FUNCTIONS[tok.v]!(...args);
    }
    return this.atom();
  }

  private atom(): MathValue {
    const tok = this.tokens[this.pos++] ?? { t: 'eof' };
    switch (tok.t) {
      case 'num':
      case 'str':
        return tok.v;
      case 'name':
        if (has(CONSTANTS, tok.v)) return CONSTANTS[tok.v]!;
        throw new ReferenceError(`undefined variable: ${tok.v}`);
      case 'op':
        if (tok.v === '(') {
          const value = this.expression();
          this.expect(')');
          return value;
        }
        throw new SyntaxError(`Unexpected "${tok.v}"`);
      default:
        throw new SyntaxError('unexpected end of expression');
    }
  }
}

/** Evaluates `expression`. Throws on anything outside the supported subset. */
export function evaluateMath(expression: string): MathValue {
  if (expression.length > 1000) throw new RangeError('expression too long');
  return new Evaluator(expression).run();
}
