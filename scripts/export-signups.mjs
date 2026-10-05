import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--remote') ? '--remote' : '--local';
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const output = execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'DB', mode, '--json', '--command',
  'SELECT name, email, school, grade, fun_fact, created_at FROM community_members ORDER BY created_at DESC;'],
  { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
const result = JSON.parse(output);
if (!Array.isArray(result) || !result[0]?.success || !Array.isArray(result[0]?.results)) {
  throw new Error('Could not read the signup database. No export was written.');
}
const columns = ['name', 'email', 'school', 'grade', 'fun_fact', 'created_at'];
function cell(value) {
  let text = String(value ?? '');
  // Treat user-supplied text as text when opened in Excel/Google Sheets.
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
const csv = [columns.join(','), ...result[0].results.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
const directory = resolve(root, 'exports');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = resolve(directory, `community-${mode.slice(2)}-${new Date().toISOString().replaceAll(':', '-')}.csv`);
writeFileSync(file, '\uFEFF' + csv, { mode: 0o600, flag: 'wx' });
console.log(`Exported ${result[0].results.length} signup(s) to ${file}`);
