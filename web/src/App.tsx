import { useEffect, useState } from "react";
import { api, ApiError, Entity, GraphResult, Repo } from "./api";
import { clearToken, getStoredToken } from "./state";
import TokenGate from "./components/TokenGate";
import ProjectPicker from "./components/ProjectPicker";
import SearchBar from "./components/SearchBar";
import GraphView from "./components/GraphView";
import EntityPanel from "./components/EntityPanel";
import CreateEntityForm from "./components/CreateEntityForm";
import CreateRelationForm from "./components/CreateRelationForm";

function entityId(e: Entity) {
  return `${e.repo ?? ""}::${e.name}`;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [projects, setProjects] = useState<{ name: string }[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [repos, setRepos] = useState<Repo[]>([]);
  const [selectedRepo, setSelectedRepo] = useState("");
  const [graph, setGraph] = useState<GraphResult | null>(null);
  const [selectedEntity, setSelectedEntity] = useState<Entity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showCreateEntity, setShowCreateEntity] = useState(false);
  const [showCreateRelation, setShowCreateRelation] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!token) return;
    api
      .listProjects(token)
      .then((res) => {
        setProjects(res.projects);
        if (res.projects.length > 0) setSelectedProject(res.projects[0].name);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
  }, [token]);

  useEffect(() => {
    if (!token || !selectedProject) return;
    api
      .listRepos(token, selectedProject)
      .then((res) => setRepos(res.repos))
      .catch((err) => setError(err instanceof ApiError ? err.message : String(err)));
    setSelectedRepo("");
    setQuery("");
  }, [token, selectedProject]);

  async function loadGraph() {
    if (!token || !selectedProject) return;
    setBusy(true);
    setError(null);
    try {
      const result = query
        ? await api.searchNodes(token, selectedProject, query, selectedRepo || undefined)
        : await api.readGraph(token, selectedProject, selectedRepo || undefined);
      setGraph(result);
      setSelectedEntity(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedProject, selectedRepo]);

  if (!token) {
    return <TokenGate onAuthenticated={setToken} />;
  }

  async function withRefresh(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadGraph();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <div className="topbar">
        <h1>Biject Brain</h1>
        <ProjectPicker
          projects={projects}
          selectedProject={selectedProject}
          onSelectProject={setSelectedProject}
          repos={repos}
          selectedRepo={selectedRepo}
          onSelectRepo={setSelectedRepo}
        />
        <SearchBar
          onSearch={(q) => {
            setQuery(q);
          }}
          onClear={() => setQuery("")}
        />
        <div style={{ flex: 1 }} />
        <button className="secondary" onClick={() => setShowCreateEntity(true)}>
          + Entity
        </button>
        <button className="secondary" onClick={() => setShowCreateRelation(true)}>
          + Relation
        </button>
        <button
          className="secondary"
          onClick={() => {
            clearToken();
            setToken(null);
          }}
        >
          Log out
        </button>
      </div>

      {error && <div className="error-banner" style={{ padding: "6px 16px" }}>{error}</div>}

      <div className="main-area">
        <GraphView
          entities={graph?.entities ?? []}
          relations={graph?.relations ?? []}
          onSelectEntity={setSelectedEntity}
          selectedId={selectedEntity ? entityId(selectedEntity) : null}
        />
        {selectedEntity && (
          <EntityPanel
            entity={selectedEntity}
            relations={graph?.relations ?? []}
            busy={busy}
            onClose={() => setSelectedEntity(null)}
            onAddObservation={(content) =>
              withRefresh(() =>
                api.addObservations(token, selectedProject, [
                  { entity: selectedEntity.name, repo: selectedEntity.repo ?? undefined, contents: [content] },
                ]),
              )
            }
            onDeleteObservation={(observationId) =>
              withRefresh(() =>
                api.deleteObservations(token, selectedProject, [
                  {
                    entity: selectedEntity.name,
                    repo: selectedEntity.repo ?? undefined,
                    observation_ids: [observationId],
                  },
                ]),
              )
            }
            onDeleteEntity={() =>
              withRefresh(() =>
                api.deleteEntities(token, selectedProject, [
                  { name: selectedEntity.name, repo: selectedEntity.repo ?? undefined },
                ]),
              )
            }
          />
        )}
      </div>

      {showCreateEntity && (
        <CreateEntityForm
          repos={repos.map((r) => r.name)}
          busy={busy}
          onClose={() => setShowCreateEntity(false)}
          onCreate={(input) =>
            withRefresh(() => api.createEntities(token, selectedProject, [input])).then(() =>
              setShowCreateEntity(false),
            )
          }
        />
      )}

      {showCreateRelation && (
        <CreateRelationForm
          entities={graph?.entities ?? []}
          busy={busy}
          onClose={() => setShowCreateRelation(false)}
          onCreate={(input) =>
            withRefresh(() => api.createRelations(token, selectedProject, [input])).then(() =>
              setShowCreateRelation(false),
            )
          }
        />
      )}
    </div>
  );
}
