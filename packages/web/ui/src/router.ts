import { useEffect, useState } from "react";

/** Tiny hash router: #/runs/<id>, #/runs/<id>/match?task=…, #/trials/<id>, #/packs/<name>. */
export type Route =
  | { page: "runs" }
  | { page: "run"; id: string }
  | { page: "match"; runId: string; task: string; model: string; vs: string }
  | { page: "trial"; id: string }
  | { page: "pack"; name: string }
  | { page: "notfound" };

export function parseRoute(hash: string): Route {
  const [path, qs = ""] = hash.replace(/^#/, "").split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(qs);
  if (parts.length === 0 || (parts[0] === "runs" && parts.length === 1)) return { page: "runs" };
  if (parts[0] === "runs" && parts.length === 2) return { page: "run", id: parts[1] };
  if (parts[0] === "runs" && parts[2] === "match") {
    return { page: "match", runId: parts[1], task: q.get("task") ?? "", model: q.get("model") ?? "", vs: q.get("vs") ?? "" };
  }
  if (parts[0] === "trials" && parts[1]) return { page: "trial", id: parts[1] };
  if (parts[0] === "packs" && parts[1]) return { page: "pack", name: parts[1] };
  return { page: "notfound" };
}

export function navigate(path: string) {
  window.location.hash = path;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = () => { setRoute(parseRoute(window.location.hash)); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
