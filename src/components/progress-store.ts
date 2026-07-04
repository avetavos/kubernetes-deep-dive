const KEY = 'k8sdd:v1';
type State = { completed: string[]; quizzes: Record<string, { correct: number; total: number }> };

function read(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { completed: [], quizzes: {} };
    const parsed = JSON.parse(raw) as Partial<State>;
    return {
      completed: Array.isArray(parsed.completed) ? parsed.completed : [],
      quizzes: parsed.quizzes && typeof parsed.quizzes === 'object' ? parsed.quizzes : {},
    };
  } catch {
    return { completed: [], quizzes: {} };
  }
}
function write(s: State) { localStorage.setItem(KEY, JSON.stringify(s)); }

export function markComplete(id: string) {
  const s = read();
  if (!s.completed.includes(id)) s.completed.push(id);
  write(s);
}
export function unmarkComplete(id: string) {
  const s = read();
  s.completed = s.completed.filter((x) => x !== id);
  write(s);
}
export function isComplete(id: string): boolean { return read().completed.includes(id); }
export function getCompleted(): string[] { return read().completed; }
export function saveQuizScore(id: string, correct: number, total: number) {
  const s = read(); s.quizzes[id] = { correct, total }; write(s);
}
export function getQuizScore(id: string) { return read().quizzes[id] ?? null; }
