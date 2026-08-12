import { useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { NodeObject, LinkObject } from "react-force-graph-2d";
import { Entity, Relation } from "../api";

export interface GraphNode extends NodeObject {
  id: string;
  name: string;
  repo: string | null;
  entity_type: string;
}

// Brand green leads (bijectai/website palette), followed by complementary
// tones that stay legible on the dark page.
const TYPE_COLORS = [
  "#10b981",
  "#ef4444",
  "#f0e15b",
  "#5b8cff",
  "#ff8f5b",
  "#9a5bff",
  "#5bf0ff",
];

function nodeId(name: string, repo: string | null) {
  return `${repo ?? ""}::${name}`;
}

function colorForType(type: string, palette: Map<string, string>) {
  if (!palette.has(type)) {
    palette.set(type, TYPE_COLORS[palette.size % TYPE_COLORS.length]);
  }
  return palette.get(type)!;
}

export default function GraphView({
  entities,
  relations,
  onSelectEntity,
  selectedId,
}: {
  entities: Entity[];
  relations: Relation[];
  onSelectEntity: (entity: Entity) => void;
  selectedId: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 800, height: 600 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ width, height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const palette = useMemo(() => new Map<string, string>(), []);

  const graphData = useMemo(() => {
    const byId = new Map(entities.map((e) => [nodeId(e.name, e.repo), e]));
    const nodes: GraphNode[] = entities.map((e) => ({
      id: nodeId(e.name, e.repo),
      name: e.name,
      repo: e.repo,
      entity_type: e.entity_type,
    }));
    const links = relations
      .filter((r) => byId.has(nodeId(r.from, r.from_repo)) && byId.has(nodeId(r.to, r.to_repo)))
      .map((r) => ({
        source: nodeId(r.from, r.from_repo),
        target: nodeId(r.to, r.to_repo),
        relation_type: r.relation_type,
      }));
    return { nodes, links };
  }, [entities, relations]);

  const entityByNodeId = useMemo(() => {
    const m = new Map<string, Entity>();
    for (const e of entities) m.set(nodeId(e.name, e.repo), e);
    return m;
  }, [entities]);

  return (
    <div ref={containerRef} className="graph-area">
      {entities.length === 0 ? (
        <div style={{ padding: 24, color: "var(--muted)" }}>
          No entities to show. Try a different search, or clear the search to see the whole graph.
        </div>
      ) : (
        <ForceGraph2D
          width={size.width}
          height={size.height}
          graphData={graphData}
          nodeId="id"
          nodeLabel={(n) => `${(n as GraphNode).name} (${(n as GraphNode).entity_type})`}
          nodeColor={(n) => colorForType((n as GraphNode).entity_type, palette)}
          nodeRelSize={5}
          linkLabel={(l) => (l as unknown as LinkObject & { relation_type: string }).relation_type}
          linkDirectionalArrowLength={4}
          linkDirectionalArrowRelPos={1}
          linkColor={() => "rgba(255,255,255,0.25)"}
          onNodeClick={(n) => {
            const entity = entityByNodeId.get((n as GraphNode).id);
            if (entity) onSelectEntity(entity);
          }}
          nodeCanvasObjectMode={() => "after"}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const n = node as GraphNode;
            const label = n.name;
            const fontSize = 11 / globalScale;
            ctx.font = `${fontSize}px sans-serif`;
            ctx.fillStyle = n.id === selectedId ? "#ffffff" : "rgba(255,255,255,0.7)";
            ctx.textAlign = "center";
            ctx.textBaseline = "top";
            ctx.fillText(label, node.x ?? 0, (node.y ?? 0) + 6);
          }}
        />
      )}
    </div>
  );
}
