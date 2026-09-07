import React from "react";

/** Page replacement bounds retained list data; navigation never drains all pages. */
export function PageControls({
  nextCursor,
  total,
  count,
  load,
  scope,
}: {
  nextCursor: string | null;
  total: number;
  count: number;
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
    setCursors([undefined]);
    setError("");
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
      if (generation.current === epoch)
        setError(failure instanceof Error ? failure.message : "Could not load page");
    } finally {
      admitted.current = false;
      setBusy(false);
    }
  };
  return (
    <nav aria-label="List pages">
      <span role="status">
        {count} shown / {total} total
      </span>{" "}
      <button
        type="button"
        disabled={busy || cursors.length < 2}
        onClick={() => void navigate(cursors.slice(0, -1))}
      >
        Previous page
      </button>{" "}
      <button
        type="button"
        disabled={busy || !nextCursor}
        onClick={() => nextCursor && void navigate([...cursors, nextCursor])}
      >
        Next page
      </button>
      {busy && <span role="status"> Loading...</span>}
      {error && <p role="alert">{error}</p>}
    </nav>
  );
}
