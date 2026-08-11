/**
 * vlx-term ↔ Pi status bridge extension, injected automatically by vlx-term.
 *
 * Sends Pi coding-agent lifecycle events to vlx-term's loopback hook service, providing authoritative
 * working and waiting states like Claude instead of relying on screen inference.
 *
 * Lifecycle mapping:
 *   - input -> working; the first input includes its prompt so the server can derive a meaningful title.
 *   - agent_start -> working as a fallback; deduplication absorbs overlap with input.
 *   - agent_end -> waiting, including error termination.
 *   - session_start -> boot, carrying Pi's session ID as a resume anchor without changing work state.
 *
 * Pi executes tools without permission prompts, so it has no asking state or permission events.
 *
 * Enabled only with VLX_SESSION_ID, VLX_TOKEN, and VLX_SPAWN_URL in a vlx-managed session. Running Pi
 * directly in a normal terminal performs no work or outbound requests.
 *
 * vlx-term passes `-e <absolute path>` when launching Pi. Pi's bundled jiti loads the TypeScript
 * directly, without changing ~/.pi or a global extension directory. Hook credentials arrive through
 * process environment and are never persisted.
 */

export default (ctx: any) => {
  const base = process.env.VLX_SPAWN_URL; // Loopback hook service shared with spawn.
  const token = process.env.VLX_TOKEN; // One-time token for this process.
  const sid = process.env.VLX_SESSION_ID; // Session ID on the vlx-term side.

  // Stay disabled outside vlx-managed sessions.
  if (!base || !token || !sid) return {};

  let lastEvent: string | null = null; // Deduplicate consecutive identical states.
  let lastPiId: string | null = null; // Resend Pi's session ID only when it changes.
  let promptSent = false; // Include prompt text only with the first input.

  // Extract the trailing UUID from a Pi session path `<timestamp>_<UUID>.jsonl`.
  const currentPiId = (): string | null => {
    try {
      const file: string = ctx?.sessionManager?.getSessionFile?.();
      if (!file) return null;
      const name = file.split(/[\\/]/).pop() || "";
      const stem = name.replace(/\.jsonl$/i, "");
      const uuid = stem.slice(stem.lastIndexOf("_") + 1);
      return uuid || null;
    } catch {
      return null;
    }
  };

  // Fire-and-forget POST; failures remain silent and never block Pi.
  const post = (event: string, body?: string) => {
    const url = `${base}/hook/${encodeURIComponent(sid)}?t=${encodeURIComponent(
      token,
    )}&e=${event}`;
    try {
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }).catch(() => {});
    } catch {
      /* Ignore edge cases such as unavailable fetch. */
    }
  };

  // Send only on state changes or new/changed Pi session IDs. extra may carry the first prompt for renaming.
  const signal = (event: string, extra?: Record<string, unknown>) => {
    const piId = currentPiId();
    const idChanged = Boolean(piId) && piId !== lastPiId;
    if (event === lastEvent && !idChanged && !extra) return;
    lastEvent = event;
    if (piId) lastPiId = piId;
    // Match the Claude hook body: session_id is the resume anchor; event name/prompt support renaming.
    const payload: Record<string, unknown> = {};
    if (piId) payload.session_id = piId;
    if (extra) Object.assign(payload, extra);
    post(event, Object.keys(payload).length ? JSON.stringify(payload) : undefined);
  };

  return {
    // On session start/resume/fork, capture only the resume anchor without changing work state.
    session_start: async () => {
      signal("boot");
    },
    // User input sets working and includes the first prompt for automatic renaming.
    input: async (payload: any) => {
      const text: string =
        typeof payload === "string" ? payload : payload?.text ?? payload?.prompt ?? "";
      const extra =
        !promptSent && text
          ? { hook_event_name: "UserPromptSubmit", prompt: text }
          : undefined;
      if (extra) promptSent = true;
      signal("working", extra);
    },
    // Agent start reinforces working; deduplication absorbs overlap with input.
    agent_start: async () => {
      signal("working");
    },
    // Agent end, including errors, sets waiting.
    agent_end: async () => {
      signal("waiting");
    },
  };
};
