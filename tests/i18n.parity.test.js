'use strict';
// Parity test for the Budget Table i18n catalogue.
// Verifies: LANGS↔files match, all files parse, inline en/de equal en.json/de.json,
// identical key sets, identical {placeholder} sets per key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const I18N_DIR = path.join(CLIENT, 'i18n');
const INDEX_HTML = path.join(CLIENT, 'index.html');

// --- helpers -----------------------------------------------------------------
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

function placeholders(str) {
  var m = String(str).match(/\{(\w+)\}/g) || [];
  return m.slice().sort().join(',');
}

function extractInlineBlock(html, id) {
  var re = new RegExp('<script[^>]+id="' + id + '"[^>]*>([\\s\\S]*?)<\\/script>');
  var m = html.match(re);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// --- load test data ----------------------------------------------------------
const html = fs.readFileSync(INDEX_HTML, 'utf8');

// Extract LANGS from the source
const langsMatch = html.match(/var LANGS\s*=\s*(\[[^\]]+\])/);
assert.ok(langsMatch, 'LANGS array not found in client/index.html');
const LANGS = JSON.parse(langsMatch[1].replace(/'/g, '"'));

// Catalogue files on disk
const onDisk = fs.readdirSync(I18N_DIR)
  .filter(function (f) { return f.endsWith('.json'); })
  .map(function (f) { return path.basename(f, '.json'); })
  .sort();

// --- tests -------------------------------------------------------------------
test('LANGS in index.html matches client/i18n/*.json files', function () {
  var sorted = LANGS.slice().sort();
  assert.deepStrictEqual(sorted, onDisk,
    'LANGS=' + JSON.stringify(sorted) + ' files=' + JSON.stringify(onDisk));
});

test('all catalogue files parse to flat objects of non-empty strings', function () {
  for (var i = 0; i < onDisk.length; i++) {
    var lang = onDisk[i];
    var catalog;
    try { catalog = readJson(path.join(I18N_DIR, lang + '.json')); }
    catch (e) { assert.fail(lang + '.json failed to parse: ' + e.message); }
    assert.strictEqual(typeof catalog, 'object', lang + '.json must be an object');
    assert.ok(!Array.isArray(catalog), lang + '.json must not be an array');
    var keys = Object.keys(catalog);
    assert.ok(keys.length > 0, lang + '.json must not be empty');
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      assert.strictEqual(typeof catalog[k], 'string', lang + '[' + k + '] must be a string');
      assert.ok(catalog[k].length > 0, lang + '[' + k + '] must not be empty');
    }
  }
});

test('inline en block in index.html deep-equals client/i18n/en.json', function () {
  var inline = extractInlineBlock(html, 'bt-i18n-en');
  assert.ok(inline, 'bt-i18n-en block not found in index.html');
  var file = readJson(path.join(I18N_DIR, 'en.json'));
  assert.deepStrictEqual(inline, file,
    'inline en block and en.json are out of sync');
});

test('inline de block in index.html deep-equals client/i18n/de.json', function () {
  var inline = extractInlineBlock(html, 'bt-i18n-de');
  assert.ok(inline, 'bt-i18n-de block not found in index.html');
  var file = readJson(path.join(I18N_DIR, 'de.json'));
  assert.deepStrictEqual(inline, file,
    'inline de block and de.json are out of sync');
});

test('all catalogues have identical key sets to en.json', function () {
  var enKeys = Object.keys(readJson(path.join(I18N_DIR, 'en.json'))).sort();
  for (var i = 0; i < onDisk.length; i++) {
    var lang = onDisk[i];
    var catalog = readJson(path.join(I18N_DIR, lang + '.json'));
    var langKeys = Object.keys(catalog).sort();
    var missing = enKeys.filter(function (k) { return langKeys.indexOf(k) < 0; });
    var extra   = langKeys.filter(function (k) { return enKeys.indexOf(k) < 0; });
    assert.deepStrictEqual(missing, [], lang + ' missing keys: ' + missing.join(', '));
    assert.deepStrictEqual(extra,   [], lang + ' extra keys: ' + extra.join(', '));
  }
});

test('all catalogues have identical {placeholder} sets per key to en.json', function () {
  var en = readJson(path.join(I18N_DIR, 'en.json'));
  for (var i = 0; i < onDisk.length; i++) {
    var lang = onDisk[i];
    if (lang === 'en') continue;
    var catalog = readJson(path.join(I18N_DIR, lang + '.json'));
    var keys = Object.keys(en);
    for (var j = 0; j < keys.length; j++) {
      var k = keys[j];
      if (catalog[k] === undefined) continue;
      var enPh   = placeholders(en[k]);
      var langPh = placeholders(catalog[k]);
      assert.strictEqual(langPh, enPh,
        lang + '[' + k + ']: placeholders differ. en=' + enPh + ' ' + lang + '=' + langPh);
    }
  }
});

test('every reason: value in server/index.js has a bt.error.reason.* key in en.json', function () {
  var serverSrc = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  var en = readJson(path.join(I18N_DIR, 'en.json'));
  // Extract all reason string literals: reason = 'FOO' or reason: 'FOO'
  var re = /reason[:\s=]+['"]([A-Z_]+)['"]/g;
  var match;
  var reasons = [];
  while ((match = re.exec(serverSrc)) !== null) reasons.push(match[1]);
  assert.ok(reasons.length > 0, 'no reason values found in server/index.js');
  for (var i = 0; i < reasons.length; i++) {
    var key = 'bt.error.reason.' + reasons[i];
    assert.ok(en[key] !== undefined, 'missing catalogue key for server reason: ' + key);
  }
  // Note: bt.error.reason.PERMISSION_DENIED is intentionally not a literal in
  // server/index.js — it is set implicitly via err.reason || code in errorResponse().
});
