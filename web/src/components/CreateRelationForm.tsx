import { useState } from "react";
import { Entity } from "../api";

export default function CreateRelationForm({
  entities,
  onCreate,
  onClose,
  busy,
}: {
  entities: Entity[];
  onCreate: (input: { from: string; to: string; relation_type: string }) => void;
  onClose: () => void;
  busy: boolean;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [relationType, setRelationType] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!from || !to || !relationType.trim()) return;
    onCreate({ from, to, relation_type: relationType.trim() });
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New relation</h2>
        <form onSubmit={submit}>
          <div className="field">
            <label>From</label>
            <select value={from} onChange={(e) => setFrom(e.target.value)}>
              <option value="">Select entity…</option>
              {entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name} {e.repo ? `(${e.repo})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Relation (active voice, e.g. "calls", "depends_on")</label>
            <input value={relationType} onChange={(e) => setRelationType(e.target.value)} placeholder="depends_on" />
          </div>
          <div className="field">
            <label>To</label>
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="">Select entity…</option>
              {entities.map((e) => (
                <option key={e.name} value={e.name}>
                  {e.name} {e.repo ? `(${e.repo})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" disabled={busy || !from || !to || !relationType.trim()}>
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
