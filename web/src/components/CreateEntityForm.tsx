import { useState } from "react";

export default function CreateEntityForm({
  repos,
  onCreate,
  onClose,
  busy,
}: {
  repos: string[];
  onCreate: (input: { name: string; entity_type: string; repo?: string }) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState("");
  const [entityType, setEntityType] = useState("");
  const [repo, setRepo] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !entityType.trim()) return;
    onCreate({ name: name.trim(), entity_type: entityType.trim(), repo: repo || undefined });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New entity</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="AuthService" />
          </div>
          <div className="field">
            <label>Type</label>
            <input
              value={entityType}
              onChange={(e) => setEntityType(e.target.value)}
              placeholder="service, module, table, convention…"
            />
          </div>
          <div className="field">
            <label>Repo (leave blank for project-wide)</label>
            <select value={repo} onChange={(e) => setRepo(e.target.value)}>
              <option value="">project-wide</option>
              {repos.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !name.trim() || !entityType.trim()}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
