import { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const TOKEN_KEY = "heddle.pocket.token";

const tabs = [
  ["Sessions", "No sessions yet"],
  ["Approvals", "You're all caught up"],
  ["Board", "Nothing here yet"],
  ["Ops", "Nothing to show yet"],
] as const;

type Connection = "checking" | "authenticated" | "denied" | "offline";

function readOnboardingToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  }
  return token;
}

async function verifyToken(): Promise<Connection> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return "denied";
  try {
    const response = await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    return response.status === 200 ? "authenticated" : "denied";
  } catch {
    return "offline";
  }
}

function Denial({ state, retry }: { state: Connection; retry: () => void }) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!token.trim()) return;
    localStorage.setItem(TOKEN_KEY, token.trim());
    retry();
  };
  return <main className="gate"><section className="card"><p className="eyebrow">heddle</p><h1>{state === "offline" ? "Can’t reach this host" : "This pocket console needs its device token"}</h1><p>{state === "offline" ? "Check that the Mac host and Tailscale Serve are available, then try again." : "Paste the token from your onboarding link to continue."}</p><form onSubmit={submit}><label htmlFor="token">Device token</label><input id="token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck="false" /><button type="submit">Connect</button></form></section></main>;
}

function App() {
  const [connection, setConnection] = useState<Connection>("checking");
  const [activeTab, setActiveTab] = useState(0);
  const retry = () => setConnection("checking");
  useEffect(() => {
    if (connection !== "checking") return;
    readOnboardingToken();
    void verifyToken().then(setConnection);
  }, [connection]);
  useEffect(() => { if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined); }, []);
  if (connection !== "authenticated") return <Denial state={connection} retry={retry} />;
  const [name, empty] = tabs[activeTab];
  return <main className="app"><header><p className="eyebrow">heddle</p><h1>{name}</h1></header><section className="card empty"><p>{empty}</p></section><nav aria-label="Pocket console"><div>{tabs.map(([tab], index) => <button key={tab} className={activeTab === index ? "active" : ""} onClick={() => setActiveTab(index)}>{tab}</button>)}</div></nav></main>;
}

createRoot(document.getElementById("root")!).render(<App />);
