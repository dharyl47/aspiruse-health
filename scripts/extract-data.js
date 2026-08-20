#!/usr/bin/env node
/**
 * data/usecases.json (server-side only, never served as a static asset) is the
 * source of truth for the confidential use-case data. This script just validates
 * it and reports counts — kept as a checkpoint so future edits to that file are
 * sanity-checked before deploying, the same way the original HTML-embedded data
 * was validated when this project used a static-only page.
 *
 * If you're editing the data, edit data/usecases.json directly, then run this
 * script to confirm it still parses and has sane shape before committing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_PATH = path.join(ROOT, 'data', 'usecases.json');

let raw;
try {
  raw = fs.readFileSync(DATA_PATH, 'utf8');
} catch (err) {
  console.error(`Could not read ${DATA_PATH}: ${err.message}`);
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`${DATA_PATH} is not valid JSON: ${err.message}`);
  process.exit(1);
}

const { UC, ALL } = parsed;
if (!Array.isArray(UC) || !Array.isArray(ALL)) {
  console.error(`${DATA_PATH} must have top-level "UC" and "ALL" arrays.`);
  process.exit(1);
}

console.log(`${DATA_PATH} OK`);
console.log(`  UC (detailed use cases):  ${UC.length}`);
console.log(`  ALL (all use cases):      ${ALL.length}`);
