import { useState } from 'preact/hooks';
import { saveQuizScore } from './progress-store';

type Q = { q: string; options: string[]; answer: number; explain?: string };

const COPY = {
  en: { submit: 'Submit', score: 'Score' },
  th: { submit: 'ส่งคำตอบ', score: 'คะแนน' },
};

// The island hydrates with client:visible, so the document is available by the
// time a reader can see the button.
function copy() {
  const lang = typeof document === 'undefined' ? 'en' : document.documentElement.lang;
  return lang?.startsWith('th') ? COPY.th : COPY.en;
}

// Quiz text is authored as markdown-ish strings: `inline code` and ```lang fences.
// Render those two constructs; everything else stays plain text.
const FENCE = /```[\w-]*\n([\s\S]*?)```/g;
const PRE_STYLE = 'font-size:0.85em;line-height:1.45;padding:0.6rem 0.8rem;margin:0.5rem 0;overflow-x:auto;' +
  'background:var(--sl-color-gray-6);border:1px solid var(--sl-color-gray-5);border-radius:6px;white-space:pre;tab-size:4';

function inline(text: string) {
  return text.split(/(`[^`]+`)/g).map((part) =>
    part.startsWith('`') && part.endsWith('`') && part.length > 2 ? <code>{part.slice(1, -1)}</code> : part,
  );
}

function split(q: string): { text: string; code: string[] } {
  const code: string[] = [];
  const text = q.replace(FENCE, (_m, body: string) => { code.push(body.replace(/\n$/, '')); return ' '; })
    .replace(/\s+/g, ' ').trim();
  return { text, code };
}

export default function Quiz({ id, questions }: { id: string; questions: Q[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const correct = questions.filter((q, i) => picked[i] === q.answer).length;
  const t = copy();

  function submit() {
    setSubmitted(true);
    saveQuizScore(id, correct, questions.length);
  }

  return (
    <div class="quiz">
      {questions.map((q, i) => {
        const { text, code } = split(q.q);
        return (
          <fieldset key={i} class="quiz__q">
            <legend>{inline(text)}</legend>
            {code.map((c) => <pre class="quiz__code" style={PRE_STYLE}><code>{c}</code></pre>)}
            {q.options.map((o, j) => (
              <label class={submitted ? (j === q.answer ? 'ok' : picked[i] === j ? 'bad' : '') : ''}>
                <input type="radio" name={`q${i}`} disabled={submitted} checked={picked[i] === j}
                  onChange={() => setPicked({ ...picked, [i]: j })} /> {inline(o)}
              </label>
            ))}
            {submitted && q.explain ? <p class="quiz__explain">{inline(q.explain)}</p> : null}
          </fieldset>
        );
      })}
      {!submitted
        ? <button class="pg__run" onClick={submit}>{t.submit}</button>
        : <p class="quiz__score">{t.score}: {correct} / {questions.length}</p>}
    </div>
  );
}
