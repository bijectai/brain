import { useState } from "react";
import { api, ApiError } from "../api";
import { storeToken } from "../state";

export default function TokenGate({ onAuthenticated }: { onAuthenticated: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const token = value.trim();
    if (!token) return;
    setChecking(true);
    setError(null);
    try {
      await api.listProjects(token);
      storeToken(token);
      onAuthenticated(token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the knowledge graph.");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="token-gate">
      <form onSubmit={submit}>
        <h1>Biject Brain</h1>
        <p style={{ color: "var(--muted)", fontSize: 13, marginTop: 0 }}>
          Paste your personal <code>kgt_…</code> knowledge graph token. It's stored only in this
          browser and sent directly to the graph API.
        </p>
        <div className="field">
          <label htmlFor="token">Token</label>
          <input
            id="token"
            type="password"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="kgt_..."
          />
        </div>
        {error && <div className="error-banner">{error}</div>}
        <button type="submit" disabled={checking || !value.trim()}>
          {checking ? "Checking…" : "Continue"}
        </button>
      </form>
    </div>
  );
}
