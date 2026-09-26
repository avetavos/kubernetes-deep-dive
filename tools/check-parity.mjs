// Bilingual (EN/TH) MDX lesson parity checker.
// Usage: node tools/check-parity.mjs
//
// For every src/content/docs/en/**/*.mdx file and its th/ pair, checks:
//   1. `##` heading count matches
//   2. quiz question count matches (parses `export const quiz... = [...]`
//      by brace/string depth, not by indentation, so it handles both
//      multi-line and single-line question objects)
//   3. the sequence of `answer:` indices matches
//   4. every TH quiz `q` and `explain` contains at least one Thai character
//      (this is the check that let six English quizzes ship inside
//      "translated" Thai lessons undetected). `options[]` entries are
//      deliberately NOT held to this rule: many correct, already-shipped
//      quizzes have options that are pure code/output/error-text by design
//      ("boom" / "<nil>" / "panic: index out of range" / "for condition { }"),
//      so a per-option Thai requirement produced 200+ false positives across
//      the existing course content with no reliable text-only way to tell
//      "intentionally all-English" apart from "forgot to translate" at the
//      single-option granularity. `q` and `explain` are prose in every
//      lesson in this course today (verified against the full corpus), so
//      checking them catches this regression class without false positives.
//      ponytail: options[] language isn't checked — if a future bug leaves
//      only options untranslated (q/explain fine), add a per-question check
//      that at least one option contains Thai, but only for questions whose
//      EN options aren't all short code/output tokens.
//   5. every `export const ...Code = \`...\`` and `<SpotTheBug code={\`...\`}>`
//      literal is byte-identical between EN and TH
//   6. no Thai characters leak into a fenced ```js code block or a code
//      literal in the TH file (```text fences are excluded on purpose: this
//      course uses them for ASCII diagrams that intentionally carry Thai
//      captions, mirroring the house rule that Mermaid diagram titles/
//      captions may be Thai while node labels stay English)
//
// Prints one line per problem, then `N files checked, M problems`, and
// exits non-zero when M > 0.

import { readFileSync, globSync } from 'node:fs';

// Files where the two locales are intentionally structured differently.
// heading: EN/TH `##` counts are allowed to differ.
const ALLOWLIST = {
  heading: new Set(['glossary.mdx']),
};

const THAI_RE = /[฀-๿]/;

function stripFrontmatter(src) {
  return src.replace(/^---[\s\S]*?\n---\n/, '');
}

function countHeadings(src) {
  return (stripFrontmatter(src).match(/^## .*/gm) || []).length;
}

// Every fence except text/mermaid/markdown counts as code and must be byte-identical EN/TH.
// Untagged fences count as code too — tag prose-like listings ```text explicitly.
// (historical note:) Fenced code blocks tagged ```js — the only fence language this course
// guarantees stays English (```text fences are used for Thai-captioned
// ASCII diagrams and are intentionally not checked here).
const NON_CODE = new Set(['text', 'txt', 'plain', 'mermaid', 'md', 'markdown']);
// Quiz arrays (`export const x = [ ... ];`) are removed first: a q string that
// embeds a fence on one physical line (\n escapes) would otherwise pair with a
// later fence and produce phantom diffs. Quiz content is checked separately.
function stripQuizArrays(src) {
  let out = '';
  let i = 0;
  const re = /export\s+const\s+\w+\s*=\s*\[/g;
  let m;
  while ((m = re.exec(src))) {
    if (m.index < i) continue;
    out += src.slice(i, m.index);
    i = scanBalanced(src, m.index + m[0].length, '[', ']');
    re.lastIndex = i;
  }
  return out + src.slice(i);
}
function fencedJsBlocks(src) {
  return [...stripQuizArrays(src).matchAll(/```(\w*)[^\n]*\n([\s\S]*?)```/g)].filter((m) => !NON_CODE.has(m[1])).map((m) => m[2]);
}

// Parse a quoted string literal (', ", or `) starting at index i.
// Returns the decoded-ish content (escapes kept raw, just consumed) and the
// index right after the closing quote.
function parseStringAt(text, i) {
  const quote = text[i];
  let j = i + 1;
  let out = '';
  while (j < text.length) {
    const c = text[j];
    if (c === '\\') {
      out += c + (text[j + 1] ?? '');
      j += 2;
      continue;
    }
    if (c === quote) {
      j++;
      break;
    }
    out += c;
    j++;
  }
  return { value: out, end: j };
}

// Find the matching closing bracket for an opener already consumed, honoring
// string literals so brackets inside quiz text/code never confuse depth.
function scanBalanced(text, start, open, close) {
  let depth = 1;
  let i = start;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      i = parseStringAt(text, i).end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) depth--;
    i++;
  }
  return i; // index right after the matching close
}

// Extract q/options/answer/explain from one `{ ... }` question object body
// (body excludes the outer braces), tolerant of key order and formatting.
function scanQuestionObject(body) {
  const result = { q: null, options: [], answer: null, explain: null };
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '"' || c === "'" || c === '`') {
      i = parseStringAt(body, i).end;
      continue;
    }
    const idMatch = /^[A-Za-z_]\w*/.exec(body.slice(i));
    if (!idMatch) {
      i++;
      continue;
    }
    const key = idMatch[0];
    let j = i + key.length;
    while (/\s/.test(body[j] ?? '')) j++;
    if (body[j] !== ':') {
      i = j;
      continue;
    }
    j++;
    while (/\s/.test(body[j] ?? '')) j++;
    if (key === 'q' || key === 'explain') {
      if (body[j] === '"' || body[j] === "'" || body[j] === '`') {
        const { value, end } = parseStringAt(body, j);
        result[key] = value;
        i = end;
        continue;
      }
    } else if (key === 'answer') {
      const numMatch = /^-?\d+/.exec(body.slice(j));
      if (numMatch) {
        result.answer = Number(numMatch[0]);
        i = j + numMatch[0].length;
        continue;
      }
    } else if (key === 'options') {
      if (body[j] === '[') {
        let k = j + 1;
        const opts = [];
        while (k < body.length && body[k] !== ']') {
          const cc = body[k];
          if (cc === '"' || cc === "'" || cc === '`') {
            const { value, end } = parseStringAt(body, k);
            opts.push(value);
            k = end;
            continue;
          }
          k++;
        }
        result.options = opts;
        i = k + 1;
        continue;
      }
    }
    i = j;
  }
  return result;
}

// Split an `export const quiz... = [ ... ]` array body into top-level
// `{ ... }` question objects, honoring string boundaries.
function splitTopLevelObjects(arrBody) {
  const objects = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  while (i < arrBody.length) {
    const c = arrBody[i];
    if (c === '"' || c === "'" || c === '`') {
      i = parseStringAt(arrBody, i).end;
      continue;
    }
    if (c === '{') {
      if (depth === 0) start = i + 1; // body starts after '{'
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(arrBody.slice(start, i));
        start = -1;
      }
    }
    i++;
  }
  return objects;
}

function parseQuizzes(src) {
  const questions = [];
  // Quiz arrays are found by usage (`<Quiz ... questions={name}`) so a differently named
  // export (e.g. `indexQuiz`) is still checked; `quiz*` names are kept as a fallback.
  const used = [...src.matchAll(/questions=\{(\w+)\}/g)].map((m) => m[1]);
  const names = used.length ? used : ['quiz\\w*'];
  const re = new RegExp(`export const (?:${names.join('|')})\\s*=\\s*\\[`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const bodyStart = re.lastIndex;
    const bodyEnd = scanBalanced(src, bodyStart, '[', ']') - 1; // exclude closing ']'
    const body = src.slice(bodyStart, bodyEnd);
    for (const objText of splitTopLevelObjects(body)) {
      questions.push(scanQuestionObject(objText));
    }
    re.lastIndex = bodyEnd + 1;
  }
  return questions;
}

// `export const xxxCode = `...`;` playground literals, keyed by variable name.
function findNamedCode(src) {
  const out = {};
  const re = /export const (\w+Code)\s*=\s*`/g;
  let m;
  while ((m = re.exec(src))) {
    const start = re.lastIndex - 1; // the opening backtick
    const { value, end } = parseStringAt(src, start);
    out[m[1]] = value;
    re.lastIndex = end;
  }
  return out;
}

// `<SpotTheBug code={`...`}>` literals, in document order.
function findSpotTheBug(src) {
  const out = [];
  const re = /<SpotTheBug\s+code=\{`/g;
  let m;
  while ((m = re.exec(src))) {
    const start = re.lastIndex - 1;
    const { value, end } = parseStringAt(src, start);
    out.push(value);
    re.lastIndex = end;
  }
  return out;
}

const files = globSync('src/content/docs/en/**/*.mdx').sort();
let problems = 0;
let checked = 0;

function report(msg) {
  console.log(msg);
  problems++;
}

for (const enPath of files) {
  const thPath = enPath.replace('/docs/en/', '/docs/th/');
  const base = enPath.split('/').pop();
  let thSrc;
  try {
    thSrc = readFileSync(thPath, 'utf8');
  } catch {
    report(`${thPath}: missing TH pair`);
    continue;
  }
  checked++;
  const enSrc = readFileSync(enPath, 'utf8');

  // 1. heading counts
  const enHeadings = countHeadings(enSrc);
  const thHeadings = countHeadings(thSrc);
  if (enHeadings !== thHeadings && !ALLOWLIST.heading.has(base)) {
    report(`${enPath}: heading count EN=${enHeadings} TH=${thHeadings}`);
  }

  // 2 & 3. quiz question count + answer sequence
  const enQuiz = parseQuizzes(enSrc);
  const thQuiz = parseQuizzes(thSrc);
  if (enQuiz.length !== thQuiz.length) {
    report(`${enPath}: quiz question count EN=${enQuiz.length} TH=${thQuiz.length}`);
  }
  const n = Math.min(enQuiz.length, thQuiz.length);
  for (let i = 0; i < n; i++) {
    if (enQuiz[i].answer !== thQuiz[i].answer) {
      report(`${enPath}: quiz[${i}] answer EN=${enQuiz[i].answer} TH=${thQuiz[i].answer}`);
    }
  }

  // 4b. every TH <Callout title="..."> / <Mermaid title="..."> / <SpotTheBug title="...">
  // must be Thai. Exempt titles that read as a proper name ("Svelte vs SvelteKit"):
  // every word capitalised or a connector. ponytail: word heuristic, allowlist if it misfires.
  const TITLE_RE = /<(Callout|Mermaid|SpotTheBug)\b[^>]*?\btitle="([^"]*)"/g;
  const thProse = stripQuizArrays(thSrc).replace(/```[\s\S]*?```/g, '');
  for (const m of thProse.matchAll(TITLE_RE)) {
    const title = m[2];
    if (THAI_RE.test(title)) continue;
    const properName = title.split(/\s+/).every((w) => /^[A-Z0-9]/.test(w) || /[a-z][A-Z]|[._()<>$]/.test(w) || /^(vs|&|and|or|of|in|to|a)$/.test(w));
    if (!properName) report(`${thPath}: <${m[1]}> title "${title}" has no Thai characters`);
  }

  // 4. every TH quiz q/explain must contain Thai text (see file-header note
  // on why options[] is excluded from this rule).
  thQuiz.forEach((question, i) => {
    if (question.q !== null && !THAI_RE.test(question.q)) {
      report(`${thPath}: quiz[${i}].q has no Thai characters`);
    }
    if (question.explain !== null && !THAI_RE.test(question.explain)) {
      report(`${thPath}: quiz[${i}].explain has no Thai characters`);
    }
  });

  // 5. playground / SpotTheBug code literals byte-identical EN vs TH
  const enCode = findNamedCode(enSrc);
  const thCode = findNamedCode(thSrc);
  const codeNames = new Set([...Object.keys(enCode), ...Object.keys(thCode)]);
  for (const name of codeNames) {
    if (!(name in enCode) || !(name in thCode)) {
      report(`${enPath}: ${name} present in only one locale`);
    } else if (enCode[name] !== thCode[name]) {
      report(`${enPath}: ${name} differs EN vs TH`);
    }
  }
  const enSpots = findSpotTheBug(enSrc);
  const thSpots = findSpotTheBug(thSrc);
  if (enSpots.length !== thSpots.length) {
    report(`${enPath}: SpotTheBug count EN=${enSpots.length} TH=${thSpots.length}`);
  } else {
    enSpots.forEach((code, i) => {
      if (code !== thSpots[i]) {
        report(`${enPath}: SpotTheBug[${i}] differs EN vs TH`);
      }
    });
  }

  // 7. every fenced code block is byte-identical EN vs TH (fences ARE the
  //    code in this course; TS Playground/verify-fences run the EN copy only)
  {
    const enF = fencedJsBlocks(enSrc), thF = fencedJsBlocks(thSrc);
    if (enF.length !== thF.length) {
      report(`${enPath}: code fence count EN=${enF.length} TH=${thF.length}`);
    } else {
      enF.forEach((b, i) => { if (b !== thF[i]) report(`${enPath}: code fence #${i} differs EN vs TH`); });
    }
  }

  // 6. no Thai characters inside a fenced code block or code literal in TH file
  {
    const enFences = fencedJsBlocks(enSrc);
    fencedJsBlocks(thSrc).forEach((block, i) => {
      if (THAI_RE.test(block) && block !== enFences[i]) {
        report(`${thPath}: Thai characters inside fenced code block #${i}`);
      }
    });
  }
  // (a literal byte-identical to EN is exempt: Thai string data is legitimate when EN carries the same bytes)
  for (const [name, code] of Object.entries(thCode)) {
    if (THAI_RE.test(code) && code !== enCode[name]) {
      report(`${thPath}: Thai characters inside ${name} playground literal`);
    }
  }
  thSpots.forEach((code, i) => {
    if (THAI_RE.test(code)) {
      report(`${thPath}: Thai characters inside SpotTheBug[${i}] literal`);
    }
  });
}

console.log(`${checked} files checked, ${problems} problems`);
process.exit(problems > 0 ? 1 : 0);
