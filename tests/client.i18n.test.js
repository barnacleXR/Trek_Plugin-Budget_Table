'use strict';
// Tests for the client-side pure i18n / formatting / parsing functions.
// Extracts code between sentinel comments and runs it in a vm context so the
// single-file no-build constraint stays intact.
const test = require('node:test');
const assert = require('node:assert');
const fs   = require('node:fs');
const path = require('node:path');
const vm   = require('node:vm');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

// Extract i18n runtime (resolveLang, loadCatalog, t, interpolate, …)
const i18nBlock = (html.match(/\/\* bt:i18n:start \*\/([\s\S]*?)\/\* bt:i18n:end \*\//) || [])[1];
assert.ok(i18nBlock, 'bt:i18n:start/end sentinels not found');

// Extract formatting / parsing functions (parseNumber, fmtDate, currencyDigits, …)
const fmtBlock  = (html.match(/\/\* bt:fmt:start \*\/([\s\S]*?)\/\* bt:fmt:end \*\//) || [])[1];
assert.ok(fmtBlock, 'bt:fmt:start/end sentinels not found');

// Extract LANGS from source
const langsMatch = html.match(/var LANGS\s*=\s*(\[[^\]]+\])/);
assert.ok(langsMatch, 'LANGS not found');
const LANGS = JSON.parse(langsMatch[1].replace(/'/g, '"'));

// Extract inline en catalog for t() fallback
function extractInline(id) {
  var re = new RegExp('<script[^>]+id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>');
  var m = html.match(re);
  return m ? JSON.parse(m[1]) : {};
}
const enCatalog = extractInline('bt-i18n-en');
const deCatalog = extractInline('bt-i18n-de');

// Build a vm context that approximates the IIFE environment.
function makeCtx(overrides) {
  var state = Object.assign({ tag: 'en', lang: 'en', baseCurrency: 'EUR' }, overrides && overrides.state);
  var ctx = vm.createContext({
    state: state,
    LANGS: LANGS,
    document: { getElementById: function (id) {
      if (id === 'bt-i18n-en') return { textContent: JSON.stringify(enCatalog) };
      if (id === 'bt-i18n-de') return { textContent: JSON.stringify(deCatalog) };
      return null;
    }},
    fetch: function () { return Promise.reject(new Error('no fetch in test')); },
    Promise: Promise,
    console: console,
    Intl: Intl,
  });
  // Run i18n block first, then fmt block
  vm.runInContext(
    'var _catalog = null, _catalogEn = null, _loadSeq = 0, _catalogs = {}, _warned = {};\n' +
    i18nBlock + '\n' +
    // seed English catalog (normally done at IIFE top level after inlineCatalog is defined)
    '_catalogEn = inlineCatalog("bt-i18n-en") || {}; _catalogs["en"] = _catalogEn; _catalog = _catalogEn;\n' +
    // fmt block references state, so inject it via closure — already in ctx
    'var _intlCache = {}, _intlCacheTag = null;\n' +
    'var _pInfoCache = null, _pInfoTag = null;\n' +
    fmtBlock,
    ctx);
  return ctx;
}

// ---------------------------------------------------------------------------
// resolveLang
// ---------------------------------------------------------------------------
test('resolveLang — exact match', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.resolveLang('de'), 'de');
  assert.strictEqual(ctx.resolveLang('en'), 'en');
});

test('resolveLang — underscore normalised', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.resolveLang('en_US'), 'en');
});

test('resolveLang — primary subtag', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.resolveLang('de-CH'), 'de');
  assert.strictEqual(ctx.resolveLang('de-AT'), 'de');
});

test('resolveLang — pt* → br when br in LANGS', function () {
  var ctx = makeCtx();
  // Stage 1 only has en+de; pt* maps to en because br is not in LANGS yet
  var result = ctx.resolveLang('pt-PT');
  assert.ok(result === 'br' || result === 'en',
    'pt-PT should resolve to br (if available) or en, got: ' + result);
});

test('resolveLang — unrecognised tag falls back to en', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.resolveLang('nb-NO'), 'en');
  assert.strictEqual(ctx.resolveLang(null),   'en');
  assert.strictEqual(ctx.resolveLang(''),     'en');
});

// ---------------------------------------------------------------------------
// t() — key lookup + interpolation + missing key
// ---------------------------------------------------------------------------
test('t — known key returns string', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.t('bt.title'), 'Budget Table');
});

test('t — {count} interpolation', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.t('costs.entries', { count: 5 }), '5 entries');
});

test('t — missing key returns the key itself and warns once', function () {
  var ctx = makeCtx();
  var warned = [];
  ctx.console = { warn: function () { warned.push(Array.from(arguments).join(' ')); } };
  var r1 = ctx.t('no.such.key');
  var r2 = ctx.t('no.such.key');
  assert.strictEqual(r1, 'no.such.key');
  assert.strictEqual(r2, 'no.such.key');
  assert.strictEqual(warned.length, 1, 'should warn exactly once per missing key');
});

test('t — unknown placeholder survives verbatim', function () {
  var ctx = makeCtx();
  // inject a key with an unusual placeholder
  ctx._catalog = { 'x.key': 'hello {world}' };
  assert.strictEqual(ctx.t('x.key', {}), 'hello {world}');
});

// ---------------------------------------------------------------------------
// parseNumber — the core regression and edge cases
// ---------------------------------------------------------------------------
test('parseNumber — de locale: "1.234,56" → 1234.56 (the 1000× regression)', function () {
  var ctx = makeCtx({ state: { tag: 'de-DE', lang: 'de', baseCurrency: 'EUR' } });
  assert.strictEqual(ctx.parseNumber('1.234,56'), 1234.56);
});

test('parseNumber — de locale: "1.234" (integer with group) → 1234', function () {
  var ctx = makeCtx({ state: { tag: 'de-DE', lang: 'de', baseCurrency: 'EUR' } });
  assert.strictEqual(ctx.parseNumber('1.234'), 1234);
});

test('parseNumber — en locale: "1,234.56" → 1234.56', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.parseNumber('1,234.56'), 1234.56);
});

test('parseNumber — fr locale: group U+202F (narrow no-break space)', function () {
  var ctx = makeCtx({ state: { tag: 'fr-FR', lang: 'fr', baseCurrency: 'EUR' } });
  // "1 234,56"
  assert.strictEqual(ctx.parseNumber('1 234,56'), 1234.56);
});

test('parseNumber — fr locale: group U+00A0 (non-breaking space)', function () {
  var ctx = makeCtx({ state: { tag: 'fr-FR', lang: 'fr', baseCurrency: 'EUR' } });
  assert.strictEqual(ctx.parseNumber('1 234,56'), 1234.56);
});

test('parseNumber — ar-SA: Arabic-Indic digits "١٬٢٣٤" → 1234', function () {
  var ctx = makeCtx({ state: { tag: 'ar-SA', lang: 'ar', baseCurrency: 'SAR' } });
  assert.strictEqual(ctx.parseNumber('١٬٢٣٤'), 1234);
});

test('parseNumber — empty string → null', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.parseNumber(''), null);
  assert.strictEqual(ctx.parseNumber(null), null);
});

test('parseNumber — non-numeric → null', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.parseNumber('abc'), null);
  assert.strictEqual(ctx.parseNumber('--5'), null);
});

test('parseNumber — exponent notation → null', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.parseNumber('1e3'), null);
});

test('parseNumber — multiple decimal separators → null', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.parseNumber('1.2.3'), null);
});

test('parseNumber — plain integer', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.parseNumber('42'), 42);
});

// ---------------------------------------------------------------------------
// currencyDigits
// ---------------------------------------------------------------------------
test('currencyDigits — EUR → 2', function () {
  var ctx = makeCtx({ state: { tag: 'en', baseCurrency: 'EUR' } });
  assert.strictEqual(ctx.currencyDigits('EUR'), 2);
});

test('currencyDigits — JPY → 0', function () {
  var ctx = makeCtx({ state: { tag: 'en', baseCurrency: 'JPY' } });
  assert.strictEqual(ctx.currencyDigits('JPY'), 0);
});

test('currencyDigits — KWD → 3', function () {
  var ctx = makeCtx({ state: { tag: 'en', baseCurrency: 'KWD' } });
  assert.strictEqual(ctx.currencyDigits('KWD'), 3);
});

// ---------------------------------------------------------------------------
// fmtDate — UTC-trap safety
// ---------------------------------------------------------------------------
test('fmtDate — "2026-08-01" contains "Aug" (or locale equiv) regardless of TZ', function () {
  var ctx = makeCtx({ state: { tag: 'en-US', lang: 'en', baseCurrency: 'USD' } });
  var result = ctx.fmtDate('2026-08-01');
  // Just check the day number appears; full month name varies by ICU version
  assert.ok(/1/.test(result), 'formatted date should contain day 1, got: ' + result);
  assert.ok(!/Jul|July|Jul\./.test(result), 'should not say July, got: ' + result);
});

test('fmtDate — non-ISO input is returned as-is', function () {
  var ctx = makeCtx();
  assert.strictEqual(ctx.fmtDate('not-a-date'), 'not-a-date');
  assert.strictEqual(ctx.fmtDate(''),  '');
  assert.strictEqual(ctx.fmtDate(null), '');
});
