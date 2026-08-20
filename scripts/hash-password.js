#!/usr/bin/env node
/**
 * Generates a bcrypt hash for the shared portal password without ever writing
 * the raw password to disk or the shell history file. Paste the printed hash
 * into the PORTAL_PASSWORD_HASH environment variable on Render — never the
 * raw password itself.
 *
 * Usage: node scripts/hash-password.js
 */
const readline = require('readline');
const bcrypt = require('bcryptjs');

function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    // Mute echo so the password isn't printed to the terminal.
    const output = rl._writeToOutput ? null : undefined;
    rl._writeToOutput = function (str) {
      if (str.startsWith(prompt)) rl.output.write(str);
      else rl.output.write('*'.repeat(str.length));
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

(async () => {
  const password = await readHidden('Password to hash (input hidden): ');
  if (!password || password.length < 12) {
    console.error('\nUse a strong password — at least 12 characters, ideally a random passphrase.');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 12);
  console.log('\nAdd this as the PORTAL_PASSWORD_HASH environment variable in Render:\n');
  console.log(hash);
  console.log('\n(The raw password was not saved anywhere — store it yourself, e.g. in a password manager.)');
})();
