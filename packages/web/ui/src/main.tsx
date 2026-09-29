import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { useRoute, type Route } from "./router.ts";
import { RunsPage } from "./pages/Runs.tsx";
import { RunPage } from "./pages/Run.tsx";
import { MatchPage } from "./pages/Match.tsx";
import { TrialPage } from "./pages/Trial.tsx";
import { HistoryPage } from "./pages/History.tsx";
import { Logo } from "./components/Logo.tsx";

type Theme = "system" | "light" | "dark";

function useTheme(): [Theme, (t: Theme) => void] {
  const read = (): Theme => {
    try { return (localStorage.getItem("axi-arena-theme") as Theme) || "system"; } catch { return "system"; }
  };
  const [theme, setTheme] = useState<Theme>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try { localStorage.setItem("axi-arena-theme", theme); } catch { /* per-viewer convenience only */ }
  }, [theme]);
  return [theme, setTheme];
}

function Crumbs({ route }: { route: Route }) {
  switch (route.page) {
    case "run": return <span className="crumbs">/ <span className="mono">{route.id}</span></span>;
    case "match": return <span className="crumbs">/ <a href={`#/runs/${route.runId}`} className="mono">{route.runId}</a> / {route.task}</span>;
    case "trial": return <span className="crumbs">/ trial</span>;
    case "pack": return <span className="crumbs">/ {route.name}</span>;
    default: return null;
  }
}

function App() {
  const route = useRoute();
  const [theme, setTheme] = useTheme();
  const next: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

  let page;
  switch (route.page) {
    case "runs": page = <RunsPage />; break;
    case "run": page = <RunPage id={route.id} key={route.id} />; break;
    case "match": page = <MatchPage {...route} key={`${route.runId}${route.task}${route.model}${route.vs}`} />; break;
    case "trial": page = <TrialPage id={route.id} key={route.id} />; break;
    case "pack": page = <HistoryPage pack={route.name} key={route.name} />; break;
    default: page = <div className="empty">Page not found. <a href="#/">All runs</a></div>;
  }

  return (
    <>
      <header className="topbar">
        <Logo />
        <Crumbs route={route} />
        <button className="theme-toggle" onClick={() => setTheme(next[theme])} title="Theme">
          {theme === "system" ? "◐ system" : theme === "light" ? "☀ light" : "☾ dark"}
        </button>
      </header>
      <main>{page}</main>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
