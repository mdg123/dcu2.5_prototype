const Database = require('better-sqlite3');
const db = new Database('./data/dacheum.db', { readonly: true });

const sample = db.prepare("SELECT id, content_id, question_text, options, answer FROM content_questions WHERE options IS NOT NULL LIMIT 30").all();
sample.forEach(r => {
  let opts;
  try { opts = JSON.parse(r.options); } catch (e) { opts = r.options; }
  console.log('id=', r.id, 'ans=', JSON.stringify(r.answer), 'opts=', opts, 'qt=', String(r.question_text).substring(0, 60));
});

console.log('--- answer distribution ---');
console.log(db.prepare("SELECT answer, COUNT(*) c FROM content_questions GROUP BY answer ORDER BY c DESC LIMIT 30").all());
console.log('--- total ---', db.prepare('SELECT COUNT(*) c FROM content_questions').get());

// Detect broken: parse options array, check if answer is in options OR is a valid index
let broken = 0, idx0Match = 0, idx1Match = 0, valMatch = 0, noOpts = 0, total = 0;
const all = db.prepare("SELECT id, options, answer FROM content_questions").all();
for (const r of all) {
  total++;
  if (!r.options) { noOpts++; continue; }
  let opts;
  try { opts = JSON.parse(r.options); } catch (e) { broken++; continue; }
  if (!Array.isArray(opts)) { broken++; continue; }
  const ans = String(r.answer || '').trim();
  // Does ans match a value in opts? (string compare)
  const valHit = opts.some(o => String(o).trim() === ans);
  // Does ans look like an index?
  const asNum = Number(ans);
  const idx0Hit = Number.isInteger(asNum) && asNum >= 0 && asNum < opts.length;
  const idx1Hit = Number.isInteger(asNum) && asNum >= 1 && asNum <= opts.length;
  if (valHit) valMatch++;
  else if (idx0Hit && opts.length <= 5) idx0Match++;
  else if (idx1Hit && opts.length <= 5) idx1Match++;
  else broken++;
}
console.log('--- format analysis ---');
console.log({ total, valMatch, idx0Match, idx1Match, broken, noOpts });
