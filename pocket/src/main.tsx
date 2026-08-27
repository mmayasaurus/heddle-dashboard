import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const TOKEN_KEY = "heddle.pocket.token";
const isValidToken = (token: string): boolean => /^[a-f0-9]{64}$/.test(token);

const tabs = [
  ["Sessions", "No sessions yet"],
  ["Approvals", "You're all caught up"],
  ["Board", "Nothing here yet"],
  ["Ops", "Nothing to show yet"],
] as const;

type Connection = "checking" | "authenticated" | "denied" | "offline";
type StatusTone = "working" | "idle" | "waiting-on-you" | "deaf-down";

type Session = {
  name: string;
  model: string | null;
  pid: number;
  sessionId: string;
  cwd: string;
  status: string;
  kind: string;
  updatedAtMs: number;
  alive: boolean;
  workers: number;
  account: string | null;
  role: string | null;
};

type TranscriptMessage = { role: string; text: string; timestamp: string | null; tools: string[] };
type SessionStatus = {
  contextPct: number | null;
  usage: { fiveHour: UsageWindow; sevenDay: UsageWindow } | null;
  account: string | null;
  mode: string | null;
  repo: string | null;
  filesEditing: string[] | null;
};
type UsageWindow = { resetsAt: string | number | null; usedPercentage: number | null };
type FleetMessage = { sender: string; body: string; ts: string | number };

function readOnboardingToken(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("token");
  if (token && isValidToken(token)) {
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

async function getJson<T>(path: string, signal: AbortSignal, deny: () => void): Promise<T> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    deny();
    throw new Error("Device token unavailable");
  }
  try {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${token}` }, signal });
    if (response.status === 401) {
      deny();
      throw new Error("Device token denied");
    }
    if (!response.ok) throw new Error(`Host returned ${response.status}`);
    return await response.json() as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw error;
  }
}

function usePoller(active: boolean, everyMs: number, request: (signal: AbortSignal) => Promise<void>) {
  useEffect(() => {
    if (!active) return;
    let current: AbortController | null = null;
    let running = false;
    const poll = () => {
      if (document.hidden || running) return;
      current?.abort();
      current = new AbortController();
      running = true;
      void request(current.signal).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }).finally(() => { running = false; });
    };
    const resume = () => { if (!document.hidden) poll(); };
    poll();
    const interval = window.setInterval(poll, everyMs);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", resume);
      current?.abort();
    };
  }, [active, everyMs, request]);
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").pop() || "—";
}

function statusTone(session: Pick<Session, "status" | "alive">): StatusTone {
  if (!session.alive) return "deaf-down";
  const status = session.status.toLowerCase();
  if (/(ask|need|block|confirm|error)/.test(status)) return "waiting-on-you";
  if (/(work|busy|run|active|think|tool)/.test(status)) return "working";
  return "idle";
}

function statusRank(tone: StatusTone): number {
  return ({ "waiting-on-you": 0, working: 1, idle: 2, "deaf-down": 3 })[tone];
}

function formatValue(value: string | number | null | undefined): string {
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function formatReset(value: string | number | null): string {
  if (value === null) return "—";
  const date = new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatUsage(usageWindow: UsageWindow | undefined): string {
  if (!usageWindow) return "—";
  if (usageWindow.usedPercentage === null) return formatReset(usageWindow.resetsAt);
  return `${usageWindow.usedPercentage}% · ${formatReset(usageWindow.resetsAt)}`;
}

function Denial({ state, retry }: { state: Connection; retry: () => void }) {
  const [token, setToken] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = token.trim();
    if (!isValidToken(trimmed)) return;
    localStorage.setItem(TOKEN_KEY, trimmed);
    retry();
  };
  return <main className="gate"><section className="card"><div className="brandbar"><img className="brandlogo" src="/heddle-logo.png" alt="" /><span className="brandtitle">heddle pocket console</span></div><h1>{state === "offline" ? "Can’t reach this host" : "This pocket console needs its device token"}</h1><p>{state === "offline" ? "Check that the Mac host and Tailscale Serve are available, then try again." : "Paste the token from your onboarding link to continue."}</p><form onSubmit={submit}><label htmlFor="token">Device token</label><input id="token" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck="false" /><button type="submit">Connect</button></form></section></main>;
}

function InlineError({ children }: { children: ReactNode }) {
  return <p className="inline-error" role="status">{children}</p>;
}

function Chip({ children }: { children: ReactNode }) {
  return <span className="chip">{children}</span>;
}

function SessionRoster({ deny, openSession, openFleet }: { deny: () => void; openSession: (session: Session) => void; openFleet: () => void }) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await getJson<{ sessions: Session[] }>("/api/sessions", signal, deny);
      setSessions(result.sessions);
      setError(false);
    } catch (fetchError) {
      if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) setError(true);
    }
  }, [deny]);
  usePoller(true, 3000, load);
  const sorted = [...(sessions ?? [])].sort((left, right) => statusRank(statusTone(left)) - statusRank(statusTone(right)));
  return <section className="session-roster" aria-label="Fleet sessions">
    <button className="card fleet-card" onClick={openFleet}><span className="fleet-card-icon" aria-hidden="true">#</span><span><strong>Fleet chat</strong><small>The read-only #fleet room</small></span><span aria-hidden="true">›</span></button>
    {error && <InlineError>Can’t reach host — showing the last available view.</InlineError>}
    {sessions?.length === 0 && <section className="card empty"><p>No sessions yet</p></section>}
    {sorted.map((session) => {
      const tone = statusTone(session);
      return <button className="card session-card" key={session.sessionId} onClick={() => openSession(session)}><span className={`status-dot ${tone}`} aria-label={tone} /><span className="session-card-copy"><span className="session-identity"><strong>{session.name}</strong>{session.account && <Chip>{session.account}</Chip>}<span className="kind">{session.kind}</span></span><span className="session-secondary"><span>{basename(session.cwd)}</span>{session.model && <Chip>{session.model}</Chip>}</span><span className="now-doing">{session.status || "—"}</span></span><span className="session-chevron" aria-hidden="true">›</span></button>;
    })}
  </section>;
}

function ScrollFeed({ children, updateKey, className = "message-feed" }: { children: ReactNode; updateKey: string; className?: string }) {
  const feed = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (follow.current) feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [updateKey]);
  const onScroll = () => {
    const element = feed.current;
    if (element) follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 56;
  };
  return <div className={className} ref={feed} onScroll={onScroll}>{children}</div>;
}

function TranscriptText({ text }: { text: string }) {
  const pieces = text.split(/```[^\n]*\n?([\s\S]*?)```/g);
  return <div className="message-text">{pieces.map((piece, index) => index % 2 === 1 ? <pre key={index}><code>{piece}</code></pre> : piece && <span key={index}>{piece}</span>)}</div>;
}

function ToolRows({ tools }: { tools: string[] }) {
  if (!tools.length) return null;
  return <div className="tool-rows">{tools.map((tool, index) => <details className="tool-row" key={`${tool}-${index}`}><summary>🔧 {tool || "tool"}</summary><p>Tool call recorded in this turn.</p></details>)}</div>;
}

function StatusStrip({ status }: { status: SessionStatus | null }) {
  const fiveHour = status?.usage?.fiveHour;
  const sevenDay = status?.usage?.sevenDay;
  const fields = [
    ["ctx", status?.contextPct === null || status?.contextPct === undefined ? "—" : `${status.contextPct}%`],
    ["5h", formatUsage(fiveHour)],
    ["week", formatUsage(sevenDay)],
    ["acct", formatValue(status?.account)],
    ["mode", formatValue(status?.mode)],
    ["repo", formatValue(status?.repo)],
    ["files", status?.filesEditing?.length ? status.filesEditing.join(", ") : "—"],
  ];
  return <div className="status-strip" aria-label="Session status">{fields.map(([label, value]) => <span key={label}><b>{label}</b> {value}</span>)}</div>;
}

function SessionChat({ session, deny, goBack }: { session: Session; deny: () => void; goBack: () => void }) {
  const [transcript, setTranscript] = useState<TranscriptMessage[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [transcriptError, setTranscriptError] = useState(false);
  const [statusError, setStatusError] = useState(false);
  const encodedId = encodeURIComponent(session.sessionId);
  const loadTranscript = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await getJson<{ messages: TranscriptMessage[]; unavailable?: string }>(`/api/sessions/${encodedId}/transcript?tail=200`, signal, deny);
      setTranscript(result.messages);
      setUnavailable(Boolean(result.unavailable));
      setTranscriptError(false);
    } catch (fetchError) {
      if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) setTranscriptError(true);
    }
  }, [deny, encodedId]);
  const loadStatus = useCallback(async (signal: AbortSignal) => {
    try {
      setStatus(await getJson<SessionStatus>(`/api/sessions/${encodedId}/status`, signal, deny));
      setStatusError(false);
    } catch (fetchError) {
      if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) setStatusError(true);
    }
  }, [deny, encodedId]);
  usePoller(true, 3000, loadTranscript);
  usePoller(true, 5000, loadStatus);
  const updateKey = transcript?.map((message) => `${message.timestamp}:${message.text.length}`).join("|") ?? "loading";
  return <section className="chat-view"><button className="back-button" onClick={goBack}>‹ Sessions</button><header className="chat-header"><div className="session-identity"><h1>{session.name}</h1>{session.account && <Chip>{session.account}</Chip>}</div><p>{basename(session.cwd)}</p></header><StatusStrip status={status} />{statusError && <InlineError>Can’t reach host — status updates will resume automatically.</InlineError>}{transcriptError && <InlineError>Can’t reach host — transcript updates will resume automatically.</InlineError>}{unavailable ? <section className="card transcript-note"><p>No transcript for this session</p></section> : <ScrollFeed updateKey={updateKey}>{transcript?.map((message, index) => <article className={`message-bubble ${message.role === "user" ? "user" : "agent"}`} key={`${message.timestamp ?? ""}-${index}`}><TranscriptText text={message.text} /><ToolRows tools={message.tools} /></article>)}</ScrollFeed>}</section>;
}

function FleetChat({ deny, goBack }: { deny: () => void; goBack: () => void }) {
  const [messages, setMessages] = useState<FleetMessage[] | null>(null);
  const [error, setError] = useState(false);
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const result = await getJson<{ messages: FleetMessage[] }>("/api/fleet-chat?tail=200", signal, deny);
      setMessages(result.messages);
      setError(false);
    } catch (fetchError) {
      if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) setError(true);
    }
  }, [deny]);
  usePoller(true, 3000, load);
  const updateKey = messages?.map((message) => `${message.ts}:${message.body.length}`).join("|") ?? "loading";
  return <section className="chat-view"><button className="back-button" onClick={goBack}>‹ Sessions</button><header className="chat-header"><p className="eyebrow">Read-only room</p><h1>Fleet chat</h1></header>{error && <InlineError>Can’t reach host — updates will resume automatically.</InlineError>}<ScrollFeed updateKey={updateKey} className="message-feed fleet-feed">{messages?.map((message, index) => <article className="fleet-message" key={`${message.ts}-${index}`}><strong>{message.sender}</strong><p>{message.body}</p></article>)}</ScrollFeed></section>;
}

function App() {
  const [connection, setConnection] = useState<Connection>("checking");
  const [attempt, setAttempt] = useState(0);
  const [activeTab, setActiveTab] = useState(0);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [fleetOpen, setFleetOpen] = useState(false);
  const retry = () => setAttempt((count) => count + 1);
  const deny = useCallback(() => setConnection("denied"), []);
  useEffect(() => {
    let cancelled = false;
    setConnection("checking");
    readOnboardingToken();
    void verifyToken().then((nextConnection) => { if (!cancelled) setConnection(nextConnection); }).catch(() => { if (!cancelled) setConnection("offline"); });
    return () => { cancelled = true; };
  }, [attempt]);
  useEffect(() => { if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => undefined); }, []);
  if (connection !== "authenticated") return <Denial state={connection} retry={retry} />;
  const [name, empty] = tabs[activeTab] ?? tabs[0];
  const changeTab = (index: number) => { setActiveTab(index); setSelectedSession(null); setFleetOpen(false); };
  let content: ReactNode = <section className="card empty"><p>{empty}</p></section>;
  if (activeTab === 0) {
    content = selectedSession ? <SessionChat session={selectedSession} deny={deny} goBack={() => setSelectedSession(null)} /> : fleetOpen ? <FleetChat deny={deny} goBack={() => setFleetOpen(false)} /> : <SessionRoster deny={deny} openSession={setSelectedSession} openFleet={() => setFleetOpen(true)} />;
  }
  return <main className="app"><div className="brandbar"><img className="brandlogo" src="/heddle-logo.png" alt="" /><span className="brandtitle">heddle pocket console</span></div>{!selectedSession && !fleetOpen && <header><h1>{name}</h1></header>}{content}<nav aria-label="Pocket console"><div>{tabs.map(([tab], index) => <button key={tab} className={activeTab === index ? "active" : ""} onClick={() => changeTab(index)}>{tab}</button>)}</div></nav></main>;
}

const rootEl = document.getElementById("root");
if (rootEl) createRoot(rootEl).render(<App />);
