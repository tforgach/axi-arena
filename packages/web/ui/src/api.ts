import { useEffect, useRef, useState } from "react";
import type { RunPayload, Trial, TrialPayload } from "./types.ts";

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  return body as T;
}

export interface Loadable<T> {
  data: T | null;
  error: string | null;
  live: boolean;
}

export function useJson<T>(url: string): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ data: null, error: null, live: false });
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, error: null }));
    getJson<T>(url)
      .then((data) => !cancelled && setState({ data, error: null, live: false }))
      .catch((e) => !cancelled && setState({ data: null, error: String(e.message ?? e), live: false }));
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

/** Run payload that keeps itself up to date over SSE while the run is in progress. */
export function useRun(id: string): Loadable<RunPayload> {
  const [state, setState] = useState<Loadable<RunPayload>>({ data: null, error: null, live: false });
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    getJson<RunPayload>(`/api/runs/${id}`)
      .then((data) => {
        if (cancelled) return;
        setState({ data, error: null, live: data.run.status === "running" });
        if (data.run.status !== "running") return;
        es = new EventSource(`/api/runs/${id}/stream`);
        es.addEventListener("run", (e) => setState({ data: JSON.parse((e as MessageEvent).data), error: null, live: true }));
        es.addEventListener("end", () => { es?.close(); setState((s) => ({ ...s, live: false })); });
        es.onerror = () => { es?.close(); setState((s) => ({ ...s, live: false })); };
      })
      .catch((e) => !cancelled && setState({ data: null, error: String(e.message ?? e), live: false }));
    return () => { cancelled = true; es?.close(); };
  }, [id]);
  return state;
}

/** Trial transcript that streams new items while the agent works. */
export function useTrial(id: string): Loadable<TrialPayload> {
  const [state, setState] = useState<Loadable<TrialPayload>>({ data: null, error: null, live: false });
  const seen = useRef(-1);
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    seen.current = -1;
    getJson<TrialPayload>(`/api/trials/${id}`)
      .then((data) => {
        if (cancelled) return;
        seen.current = data.lastSeq;
        // Still running, or finished but not graded yet (the server ends the stream if it never will be).
        const live = data.trial.status === "queued" || data.trial.status === "running" || (data.trial.status !== "setup_error" && !data.trial.judgment);
        setState({ data, error: null, live });
        if (!live) return;
        es = new EventSource(`/api/trials/${id}/stream?after=${data.lastSeq}`);
        es.addEventListener("items", (e) => {
          const { items, lastSeq, costs } = JSON.parse((e as MessageEvent).data) as Pick<TrialPayload, "items" | "lastSeq" | "costs">;
          if (lastSeq <= seen.current) return;
          seen.current = lastSeq;
          setState((s) => (s.data ? { ...s, data: { ...s.data, items: [...s.data.items, ...items], lastSeq, costs } } : s));
        });
        es.addEventListener("trial", (e) => {
          const trial = JSON.parse((e as MessageEvent).data) as Trial;
          setState((s) => (s.data ? { ...s, data: { ...s.data, trial } } : s));
        });
        es.addEventListener("end", () => { es?.close(); setState((s) => ({ ...s, live: false })); });
        es.onerror = () => { es?.close(); setState((s) => ({ ...s, live: false })); };
      })
      .catch((e) => !cancelled && setState({ data: null, error: String(e.message ?? e), live: false }));
    return () => { cancelled = true; es?.close(); };
  }, [id]);
  return state;
}
