import { useState } from 'preact/hooks';
import { isComplete, markComplete, unmarkComplete } from './progress-store';

export default function ProgressTracker({ id }: { id: string }) {
  const [done, setDone] = useState(() => isComplete(id));
  function toggle() {
    if (done) { unmarkComplete(id); setDone(false); }
    else { markComplete(id); setDone(true); }
  }
  return (
    <button class={`pt ${done ? 'pt--done' : ''}`} onClick={toggle}>
      {done ? '✓ Completed' : 'Mark as complete'}
    </button>
  );
}
