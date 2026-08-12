const WEB_API_URL =
  import.meta.env.VITE_WEB_API_URL ??
  "https://litdbmyvvqrbpocohlpw.supabase.co/functions/v1/web-api";

export interface Project {
  id: string;
  name: string;
}

export interface Repo {
  name: string;
  entities: number;
}

export interface Observation {
  id: string;
  content: string;
  created_at: string;
  created_by: string | null;
}

export interface Entity {
  name: string;
  repo: string | null;
  entity_type: string;
  updated_at?: string;
  observations: Observation[];
}

export interface Relation {
  from: string;
  from_repo: string | null;
  to: string;
  to_repo: string | null;
  relation_type: string;
}

export interface GraphResult {
  project: string;
  entities: Entity[];
  relations: Relation[];
  entity_count?: number;
  truncated?: boolean;
  note?: string;
}

export class ApiError extends Error {}

async function callTool<T>(token: string, tool: string, args: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${WEB_API_URL}/tools/${tool}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(args),
  });
  const body = await res.json();
  if (!res.ok) {
    throw new ApiError(body.error ?? `Request failed with ${res.status}`);
  }
  return body as T;
}

export const api = {
  listProjects: (token: string) =>
    callTool<{ employee: string; projects: (Project & { entities: number; relations: number; repos: number })[] }>(
      token,
      "list_projects",
      {},
    ),

  listRepos: (token: string, project?: string) =>
    callTool<{ project: string; repos: Repo[]; project_wide_entities: number }>(token, "list_repos", { project }),

  readGraph: (token: string, project?: string, repo?: string, limit = 250) =>
    callTool<GraphResult>(token, "read_graph", { project, repo, limit }),

  searchNodes: (token: string, project: string | undefined, query: string, repo?: string) =>
    callTool<GraphResult>(token, "search_nodes", { project, query, repo, limit: 100 }),

  createEntities: (
    token: string,
    project: string | undefined,
    entities: { name: string; entity_type: string; repo?: string; observations?: string[] }[],
  ) => callTool<unknown>(token, "create_entities", { project, entities }),

  createRelations: (
    token: string,
    project: string | undefined,
    relations: { from: string; from_repo?: string; to: string; to_repo?: string; relation_type: string }[],
  ) => callTool<unknown>(token, "create_relations", { project, relations }),

  addObservations: (
    token: string,
    project: string | undefined,
    observations: { entity: string; repo?: string; contents: string[] }[],
  ) => callTool<unknown>(token, "add_observations", { project, observations }),

  deleteEntities: (token: string, project: string | undefined, entities: { name: string; repo?: string }[]) =>
    callTool<unknown>(token, "delete_entities", { project, entities }),

  deleteRelations: (
    token: string,
    project: string | undefined,
    relations: { from: string; from_repo?: string; to: string; to_repo?: string; relation_type: string }[],
  ) => callTool<unknown>(token, "delete_relations", { project, relations }),

  deleteObservations: (
    token: string,
    project: string | undefined,
    deletions: { entity: string; repo?: string; observation_ids?: string[] }[],
  ) => callTool<unknown>(token, "delete_observations", { project, deletions }),
};
