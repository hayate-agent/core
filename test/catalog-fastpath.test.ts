import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogLanguage } from '../src/language.js';

test('exact catalog tags avoid canonicalization without changing fallback validation', () => {
  const original = Intl.getCanonicalLocales;
  let calls = 0;
  Intl.getCanonicalLocales = (value) => { calls++; return original(value); };
  try {
    for (const locale of ['en', 'de', 'es', 'ru']) assert.equal(catalogLanguage(locale), locale);
    assert.equal(calls, 0);
    for (const [locale, expected] of [['EN', 'en'], ['de-DE', 'de'], ['es-MX', 'es'], ['ru-RU', 'ru'], ['fr', 'en'], ['zh-Hant-TW', 'en']]) {
      assert.equal(catalogLanguage(locale), expected);
    }
    for (const locale of ['', 'invalid_tag', 'en\n', 'und', '__proto__', 'constructor']) assert.throws(() => catalogLanguage(locale));
    assert.throws(() => catalogLanguage({ toString: () => 'en' } as unknown as string));
  } finally { Intl.getCanonicalLocales = original; }
});
