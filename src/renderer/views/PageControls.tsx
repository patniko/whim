import React from "react";

/** Page replacement bounds retained list data; navigation never drains all pages. */
export function PageControls({
  nextCursor,
  load,
  scope,
}: {
  nextCursor: string | null;
  load: (cursor?: string) => Promise<void>;
  scope: string;
}) {
  const [cursors, setCursors] = React.useState<Array<string | undefined>>([undefined]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const generation = React.useRef(0);
  const admitted = React.useRef(false);
  React.useEffect(() => {
    generation.current++;
    admitted.current = false;
    setBusy(false);
    setCursors([undefined]);
    setError("");
    return () => { generation.current++; };
  }, [scope]);
  const navigate = async (next: Array<string | undefined>) => {
    if (admitted.current) return;
    admitted.current = true;
    const epoch = generation.current;
    setBusy(true);
    setError("");
    try {
      await load(next[next.length - 1]);
      if (generation.current === epoch) setCursors(next);
    } catch (failure) {
      if (generation.current === epoch) {
        console.error("[list] navigation failed", failure);
        setError("Couldn't load more items. Please try again.");
      }
    } finally {
      if (generation.current === epoch) {
        admitted.current = false;
        setBusy(false);
      }
    }
  };
  if (!nextCursor && cursors.length < 2 && !busy && !error) return null;
  return (
    <nav className="list-navigation" aria-label="Browse list" aria-busy={busy}>
      {cursors.length > 1 && <button
        type="button"
        disabled={busy}
        onClick={() => void navigate(cursors.slice(0, -1))}
      >
        Previous
      </button>}
      {nextCursor && <button
        type="button"
        disabled={busy}
        onClick={() => nextCursor && void navigate([...cursors, nextCursor])}
      >
        Next
      </button>}
      {busy && <span role="status">Loading...</span>}
      {error && <p role="alert">{error}</p>}
    </nav>
  );
}
