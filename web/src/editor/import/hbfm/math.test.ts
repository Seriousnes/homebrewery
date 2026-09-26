// evaluateMath must agree with expr-eval as marked-variables configures it (the oracle below is
// a test-only import of the transitive expr-eval package) on the syntax brews use, and refuse
// everything else.
import { Parser } from 'expr-eval';
import { describe, expect, it } from 'vitest';
import { evaluateMath, romanize, writtenNumber } from './math';

// marked-variables/src/index.js:10-44
const oracle = new Parser({
  operators: {
    add: true, subtract: true, multiply: true, divide: true, power: true, round: true, floor: true, ceil: true, abs: true,
    sin: false, cos: false, tan: false, asin: false, acos: false, atan: false, sinh: false, cosh: false, tanh: false,
    asinh: false, acosh: false, atanh: false, sqrt: false, cbrt: false, log: false, log2: false, ln: false, lg: false,
    log10: false, expm1: false, log1p: false, trunc: false, join: false, sum: false, indexOf: false, '-': false,
    '+': false, exp: false, not: false, length: false, '!': false, sign: false, random: false, fac: false, min: false,
    max: false, hypot: false, pyt: false, pow: false, atan2: false, if: false, gamma: false, roundTo: false, map: false,
    fold: false, filter: false, remainder: false, factorial: false, comparison: false, concatenate: false,
    logical: false, assignment: false, array: false, fndef: false,
  } as Record<string, boolean>,
});

const same = [
  '1 + 3 * 5 - (1 / 4)',
  'round(1/4)',
  'round 2.5',
  'round(-2.5)',
  'floor(-0.5)',
  'ceil(0.2)',
  'ceil(floor(round(0.6)))',
  'abs(-3)',
  'abs -3',
  '-5',
  '+5',
  '--2',
  '-(-2)',
  '2*-3',
  '-2^2',
  '2^3^2',
  '2^-1',
  '2 ^ 0.5',
  '5 / 2 / 2',
  '2*(3+4)',
  '1e3',
  '.5',
  '0x10',
  '1/0',
  'min(1,4)',
  'max(1,4,9)',
  'min()',
  'pow(2,3)',
  'hypot(3,4)',
  'atan2(1,1)',
  'fac(5)',
  'roundTo(1.2345,2)',
  'roundTo(1234.5,-2)',
  'PI',
  'E * 2',
  '1 ? 2 : 3',
  '0 ? 2 : 3',
  'round(1/4)^2',
  '"abc"',
  "'a\\'b'",
];

describe('evaluateMath', () => {
  it.each(same)('%s matches expr-eval', (expr) => {
    expect(evaluateMath(expr)).toEqual(oracle.evaluate(expr));
  });

  it('adds the Homebrewery functions', () => {
    expect(evaluateMath('sign(3)')).toBe('+');
    expect(evaluateMath('sign(-1)')).toBe('-');
    expect(evaluateMath('signed(13)')).toBe('+13');
    expect(evaluateMath('signed(-11)')).toBe('-11');
    expect(evaluateMath('toRomans(18)')).toBe('XVIII');
    expect(evaluateMath('toRomansLower(18)')).toBe('xviii');
    expect(evaluateMath('toChar(39)')).toBe('AM');
    expect(evaluateMath('toCharLower(18)')).toBe('r');
    expect(evaluateMath('toWords(80085)')).toBe('eighty thousand and eighty-five');
    expect(evaluateMath('toWordsCaps(80085)')).toBe('Eighty Thousand And Eighty-Five');
  });

  it.each(['a', 'sqrt(4)', 'sin(1)', '5 % 2', '1 == 1', 'x = 1', '[1,2]', '3!', '', '1+', '2 3', 'abs(1,2)', 'foo(1)', '1.5.5'])(
    '%s throws like expr-eval',
    (expr) => {
      expect(() => evaluateMath(expr)).toThrow();
      expect(() => oracle.evaluate(expr)).toThrow();
    },
  );

  it.each([
    'constructor',
    '__proto__',
    'toString',
    'min.constructor',
    'this',
    'globalThis',
    'Function("return 1")()',
    'toRomans.constructor("return 1")()',
    '(1).constructor',
    'hasOwnProperty',
  ])('refuses %s', (expr) => {
    expect(() => evaluateMath(expr)).toThrow();
  });

  it('refuses very long expressions', () => {
    expect(() => evaluateMath('1+'.repeat(600) + '1')).toThrow(RangeError);
  });

  it('returns quickly on huge arguments (no loops proportional to the input)', () => {
    const start = performance.now();
    expect(evaluateMath('fac(1e12)')).toBe(Infinity);
    expect(evaluateMath('fac(170)')).toBeGreaterThan(1e306);
    expect(typeof evaluateMath('toWords(1e300)')).toBe('string');
    expect(typeof evaluateMath('toChar(1e300)')).toBe('string');
    expect(() => evaluateMath('toRomans(1e300)')).toThrow(RangeError);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe('romanize / writtenNumber', () => {
  it('match the romans and written-number packages', () => {
    expect(romanize(1994)).toBe('MCMXCIV');
    expect(() => romanize(0)).toThrow();
    expect(() => romanize(4000)).toThrow();
    expect(() => romanize(1.5)).toThrow();
    expect(writtenNumber(0)).toBe('zero');
    expect(writtenNumber(21)).toBe('twenty-one');
    expect(writtenNumber(100)).toBe('one hundred');
    expect(writtenNumber(101)).toBe('one hundred and one');
    expect(writtenNumber(1000000)).toBe('one million');
    expect(writtenNumber(1234567)).toBe('one million two hundred thirty-four thousand five hundred and sixty-seven');
    expect(writtenNumber(1001)).toBe('one thousand and one');
    expect(writtenNumber(110)).toBe('one hundred and ten');
    expect(writtenNumber(2000000001)).toBe('two billion and one');
    expect(writtenNumber(-1)).toBe('');
  });
});
