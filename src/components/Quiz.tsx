import { useState } from 'preact/hooks';
import { saveQuizScore } from './progress-store';

type Q = { q: string; options: string[]; answer: number };

export default function Quiz({ id, questions }: { id: string; questions: Q[] }) {
  const [picked, setPicked] = useState<Record<number, number>>({});
  const [submitted, setSubmitted] = useState(false);
  const correct = questions.filter((q, i) => picked[i] === q.answer).length;

  function submit() {
    setSubmitted(true);
    saveQuizScore(id, correct, questions.length);
  }

  return (
    <div class="quiz">
      {questions.map((q, i) => (
        <fieldset key={i} class="quiz__q">
          <legend>{q.q}</legend>
          {q.options.map((o, j) => (
            <label class={submitted ? (j === q.answer ? 'ok' : picked[i] === j ? 'bad' : '') : ''}>
              <input type="radio" name={`q${i}`} disabled={submitted} checked={picked[i] === j}
                onChange={() => setPicked({ ...picked, [i]: j })} /> {o}
            </label>
          ))}
        </fieldset>
      ))}
      {!submitted
        ? <button class="pg__run" onClick={submit}>Submit</button>
        : <p class="quiz__score">Score: {correct} / {questions.length}</p>}
    </div>
  );
}
