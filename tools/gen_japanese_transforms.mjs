// Converts Yomitan's ext/js/language/ja/japanese-transforms.js into the JSON
// rule table used by py_modules/providers/dictionary/deinflector.py.
//
// Usage: node tools/gen_japanese_transforms.mjs <path/to/japanese-transforms.js>
//
// The source file only imports the rule-builder helpers from
// ../language-transforms.js, so it is evaluated next to a stub of those helpers
// that records each rule as plain data instead of building RegExps.
//
// Yomitan is GPL-3.0-or-later (https://github.com/yomidevs/yomitan), as is this plugin.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const source = process.argv[2];
if (!source) {
    console.error('Usage: node tools/gen_japanese_transforms.mjs <japanese-transforms.js>');
    process.exit(1);
}

const stub = `
export function suffixInflection(inflected, deinflected, conditionsIn, conditionsOut) {
    return {type: 'suffix', inflected, deinflected, conditionsIn, conditionsOut};
}
export function prefixInflection(inflected, deinflected, conditionsIn, conditionsOut) {
    return {type: 'prefix', inflected, deinflected, conditionsIn, conditionsOut};
}
export function wholeWordInflection(inflected, deinflected, conditionsIn, conditionsOut) {
    return {type: 'wholeWord', inflected, deinflected, conditionsIn, conditionsOut};
}
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ja-transforms-'));
fs.mkdirSync(path.join(work, 'ja'));
fs.writeFileSync(path.join(work, 'language-transforms.js'), stub);
fs.copyFileSync(source, path.join(work, 'ja', 'japanese-transforms.js'));

const { japaneseTransforms } = await import(pathToFileURL(path.join(work, 'ja', 'japanese-transforms.js')).href);
fs.rmSync(work, { recursive: true, force: true });

const conditions = {};
for (const [id, c] of Object.entries(japaneseTransforms.conditions)) {
    conditions[id] = { name: c.name, isDictionaryForm: !!c.isDictionaryForm };
    if (c.subConditions) conditions[id].subConditions = c.subConditions;
}

const transforms = {};
for (const [id, t] of Object.entries(japaneseTransforms.transforms)) {
    transforms[id] = {
        name: t.name,
        description: t.description || '',
        rules: t.rules.map(r => [r.type, r.inflected, r.deinflected, r.conditionsIn, r.conditionsOut]),
    };
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'py_modules', 'providers', 'dictionary', 'japanese_transforms.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
    source: 'yomitan ext/js/language/ja/japanese-transforms.js (GPL-3.0-or-later)',
    ruleFormat: ['type', 'inflected', 'deinflected', 'conditionsIn', 'conditionsOut'],
    conditions,
    transforms,
}, null, 0) + '\n');

const ruleCount = Object.values(transforms).reduce((n, t) => n + t.rules.length, 0);
console.log(`Wrote ${out}: ${Object.keys(conditions).length} conditions, ${Object.keys(transforms).length} transforms, ${ruleCount} rules`);
