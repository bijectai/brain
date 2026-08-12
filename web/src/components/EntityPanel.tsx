import { useState } from "react";
import { Entity, Relation } from "../api";

export default function EntityPanel({
  entity,
  relations,
  onClose,
  onAddObservation,
  onDeleteObservation,
  onDeleteEntity,
  busy,
}: {
  entity: Entity;
  relations: Relation[];
  onClose: () => void;
  onAddObservation: (content: string) => void;
  onDeleteObservation: (observationId: string) => void;
  onDeleteEntity: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState("");
  const touching = relations.filter(
    (r) => (r.from === entity.name && r.from_repo === entity.repo) || (r.to === entity.name && r.to_repo === entity.repo),
  );

  return (
    <div className="side-panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div>
          <h2 style={{ margin: 0 }}>{entity.name}</h2>
          <div style={{ color: "var(--muted)", fontSize: 12 }}>
            {entity.entity_type} · {entity.repo ?? "project-wide"}
          </div>
        </div>
        <button className="secondary" onClick={onClose}>
          ✕
        </button>
      </div>

      <h3 style={{ fontSize: 13, marginTop: 20 }}>Observations</h3>
      {entity.observations.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>None yet.</div>}
      {entity.observations.map((o) => (
        <div key={o.id} className="observation">
          <div>{o.content}</div>
          <div className="meta">
            {o.created_by ?? "unknown"} · {new Date(o.created_at).toLocaleDateString()}
            <button
              className="secondary"
              style={{ marginLeft: 8, padding: "1px 6px", fontSize: 11 }}
              disabled={busy}
              onClick={() => onDeleteObservation(o.id)}
            >
              remove
            </button>
          </div>
        </div>
      ))}
      <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a fact…"
          style={{ flex: 1 }}
        />
        <button
          disabled={busy || !draft.trim()}
          onClick={() => {
            onAddObservation(draft.trim());
            setDraft("");
          }}
        >
          Add
        </button>
      </div>

      <h3 style={{ fontSize: 13, marginTop: 20 }}>Relations</h3>
      {touching.length === 0 && <div style={{ color: "var(--muted)", fontSize: 13 }}>None.</div>}
      {touching.map((r, i) => (
        <div key={i} className="relation-row">
          {r.from} <span style={{ color: "var(--accent)" }}>{r.relation_type}</span> {r.to}
        </div>
      ))}

      <button className="danger" style={{ marginTop: 24 }} disabled={busy} onClick={onDeleteEntity}>
        Delete entity
      </button>
    </div>
  );
}
