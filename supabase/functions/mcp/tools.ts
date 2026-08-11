import { withTenant } from "./db.ts";
import type { Sql } from "./db.ts";
import type { Caller } from "./auth.ts";

// ---------------------------------------------------------------------------
// Request context
// ---------------------------------------------------------------------------

export interface Project {
  id: string;
  name: string;
}

export class ToolError extends Error {}

export class Ctx {
  #projects: Project[] | null = null;

  constructor(public readonly caller: Caller) {}

  /** The caller's projects, fetched once per request. */
  async projects(): Promise<Project[]> {
    if (this.#projects) return this.#projects;
    this.#projects = await withTenant(
      this.caller.projectIds,
      (tx) => tx<Project[]>`select id, name from public.projects order by name`,
    );
    return this.#projects;
  }

  /**
   * Picks the project a call operates on. Accepts a name or a uuid. When the
   * token holds exactly one project the argument may be omitted; when it holds
   * several, omitting it is an error rather than a guess.
   */
  async resolveProject(ref?: string): Promise<Project> {
    const projects = await this.projects();
    if (projects.length === 0) {
      throw new ToolError("This token is not granted access to any project.");
    }
    if (!ref) {
      if (projects.length === 1) return projects[0];
      throw new ToolError(
        `This token can access ${projects.length} projects, so "project" is ` +
          `required. One of: ${projects.map((p) => p.name).join(", ")}`,
      );
    }
    const needle = ref.trim().toLowerCase();
    const hit = projects.find(
      (p) => p.id === needle || p.name.toLowerCase() === needle,
    );
    if (!hit) {
      throw new ToolError(
        `Unknown or inaccessible project "${ref}". This token can access: ` +
          `${projects.map((p) => p.name).join(", ") || "(none)"}`,
      );
    }
    return hit;
  }

  /** Opens a transaction pinned to a single project. */
  run<T>(projectId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return withTenant([projectId], fn);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function arr<T>(v: unknown, field: string): T[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new ToolError(`"${field}" must be a non-empty array.`);
  }
  return v as T[];
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new ToolError(`"${field}" must be a non-empty string.`);
  }
  return v.trim();
}

/** Reports names the caller referenced that do not exist in the project. */
async function assertEntitiesExist(
  tx: Sql,
  projectId: string,
  names: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(names)];
  const rows = await tx<{ id: string; name: string }[]>`
    select id, name from public.entities
    where project_id = ${projectId} and name = any(${unique})`;
  const byName = new Map(rows.map((r) => [r.name, r.id]));
  const missing = unique.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new ToolError(
      `No such entities in this project: ${missing.join(", ")}. ` +
        `Create them with create_entities first.`,
    );
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const PROJECT_ARG = {
  type: "string",
  description:
    "Project name or id. Optional when your token only has one project.",
} as const;

type Handler = (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: Handler;
}

export const TOOLS: Tool[] = [
  // -------------------------------------------------------------------------
  {
    name: "search_nodes",
    title: "Search the knowledge graph",
    description:
      "Find entities by name, type, or the text of their observations, and " +
      "return them with their observations and the relations touching them. " +
      "This is the tool to use for routine lookups -- start every session " +
      "here rather than with read_graph.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free text. Matched against entity names (exact, prefix and fuzzy) " +
            "and against observation content. May be omitted if entity_types " +
            "is given.",
        },
        entity_types: {
          type: "array",
          items: { type: "string" },
          description: "Restrict results to these entity types.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 25,
          description: "Maximum entities to return.",
        },
        include_relations: {
          type: "boolean",
          default: true,
          description:
            "Include relations that touch the matched entities, including " +
            "edges to neighbours outside the result set.",
        },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const query = typeof args.query === "string" ? args.query.trim() : "";
      const types = Array.isArray(args.entity_types)
        ? (args.entity_types as string[])
        : null;
      if (!query && !types) {
        throw new ToolError('Provide "query", "entity_types", or both.');
      }
      const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 200);
      const withRelations = args.include_relations !== false;

      return ctx.run(project.id, async (tx) => {
        const matched = await tx<
          {
            id: string;
            name: string;
            entity_type: string;
            created_at: string;
            updated_at: string;
            score: number;
          }[]
        >`
          select e.id, e.name, e.entity_type, e.created_at, e.updated_at,
                 case when ${query} = '' then 1.0 else greatest(
                   case when lower(e.name) = lower(${query}) then 1.0 else 0 end,
                   case when e.name ilike ${query + "%"} then 0.9 else 0 end,
                   case when e.name ilike ${"%" + query + "%"} then 0.7 else 0 end,
                   case when lower(e.entity_type) = lower(${query}) then 0.8 else 0 end,
                   similarity(e.name, ${query}),
                   case when exists (
                     select 1 from public.observations o
                     where o.entity_id = e.id
                       and to_tsvector('english', o.content)
                           @@ plainto_tsquery('english', ${query})
                   ) then 0.6 else 0 end
                 ) end as score
          from public.entities e
          where (${types}::text[] is null or e.entity_type = any(${types}))
          order by score desc, e.updated_at desc, e.name
          limit ${limit}`;

        const hits = matched.filter((m) => m.score >= 0.2);
        if (hits.length === 0) {
          return {
            project: project.name,
            query: query || null,
            entities: [],
            relations: [],
            note:
              "No matches. Try a shorter or more distinctive term, or call " +
              "list_projects to confirm you are querying the right project.",
          };
        }

        const ids = hits.map((h) => h.id);
        const observations = await tx<
          { entity_id: string; id: string; content: string; created_at: string; created_by: string | null }[]
        >`
          select entity_id, id, content, created_at, created_by
          from public.observations
          where entity_id = any(${ids})
          order by created_at desc`;

        const byEntity = new Map<string, unknown[]>();
        for (const o of observations) {
          const list = byEntity.get(o.entity_id) ?? [];
          if (list.length < 25) {
            list.push({
              id: o.id,
              content: o.content,
              created_at: o.created_at,
              created_by: o.created_by,
            });
          }
          byEntity.set(o.entity_id, list);
        }

        const relations = withRelations
          ? await tx<
            { id: string; from: string; to: string; relation_type: string }[]
          >`
            select r.id, f.name as "from", t.name as "to", r.relation_type
            from public.relations r
            join public.entities f on f.id = r.from_entity_id
            join public.entities t on t.id = r.to_entity_id
            where r.from_entity_id = any(${ids}) or r.to_entity_id = any(${ids})
            order by f.name, r.relation_type, t.name`
          : [];

        return {
          project: project.name,
          query: query || null,
          entities: hits.map((h) => ({
            name: h.name,
            entity_type: h.entity_type,
            updated_at: h.updated_at,
            observations: byEntity.get(h.id) ?? [],
          })),
          relations,
        };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "read_graph",
    title: "Dump the whole graph",
    description:
      "Return every entity, observation and relation in a project. Intended " +
      "for small graphs and explicit audits only -- for routine lookups use " +
      "search_nodes, which is far cheaper. The response is truncated at " +
      "`limit` entities and says so when that happens.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          default: 250,
          description: "Maximum entities to return.",
        },
        project: PROJECT_ARG,
      },
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const limit = Math.min(Math.max(Number(args.limit ?? 250), 1), 1000);

      return ctx.run(project.id, async (tx) => {
        const [{ count }] = await tx<{ count: number }[]>`
          select count(*)::int as count from public.entities`;

        const entities = await tx<
          { id: string; name: string; entity_type: string; updated_at: string }[]
        >`
          select id, name, entity_type, updated_at
          from public.entities order by name limit ${limit}`;

        const ids = entities.map((e) => e.id);
        const observations = ids.length === 0 ? [] : await tx<
          { entity_id: string; id: string; content: string; created_at: string; created_by: string | null }[]
        >`
          select entity_id, id, content, created_at, created_by
          from public.observations
          where entity_id = any(${ids}) order by created_at`;

        const relations = ids.length === 0 ? [] : await tx<
          { from: string; to: string; relation_type: string }[]
        >`
          select f.name as "from", t.name as "to", r.relation_type
          from public.relations r
          join public.entities f on f.id = r.from_entity_id
          join public.entities t on t.id = r.to_entity_id
          where r.from_entity_id = any(${ids}) and r.to_entity_id = any(${ids})
          order by f.name, r.relation_type, t.name`;

        const byEntity = new Map<string, unknown[]>();
        for (const o of observations) {
          const list = byEntity.get(o.entity_id) ?? [];
          list.push({
            id: o.id,
            content: o.content,
            created_at: o.created_at,
            created_by: o.created_by,
          });
          byEntity.set(o.entity_id, list);
        }

        return {
          project: project.name,
          entity_count: count,
          truncated: count > entities.length,
          ...(count > entities.length
            ? {
              note:
                `Showing ${entities.length} of ${count} entities. This graph is ` +
                `too big to read whole -- use search_nodes instead.`,
            }
            : {}),
          entities: entities.map((e) => ({
            name: e.name,
            entity_type: e.entity_type,
            observations: byEntity.get(e.id) ?? [],
          })),
          relations,
        };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "create_entities",
    title: "Create or update entities",
    description:
      "Create entities in bulk. Names are unique per project: re-creating an " +
      "existing name updates its type and leaves its observations intact, so " +
      "this is safe to call repeatedly.",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "Unique within the project, e.g. 'AuthService'.",
              },
              entity_type: {
                type: "string",
                description:
                  "e.g. 'service', 'module', 'table', 'convention', 'person'.",
              },
              observations: {
                type: "array",
                items: { type: "string" },
                description: "Optional facts to attach immediately.",
              },
            },
            required: ["name", "entity_type"],
            additionalProperties: false,
          },
        },
        project: PROJECT_ARG,
      },
      required: ["entities"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const input = arr<{ name: string; entity_type: string; observations?: string[] }>(
        args.entities,
        "entities",
      );
      const names = input.map((e) => str(e.name, "entities[].name"));
      const types = input.map((e) => str(e.entity_type, "entities[].entity_type"));

      return ctx.run(project.id, async (tx) => {
        const rows = await tx<
          { id: string; name: string; entity_type: string; created: boolean }[]
        >`
          insert into public.entities (project_id, name, entity_type)
          select ${project.id}::uuid, u.n, u.t
          from unnest(${names}::text[], ${types}::text[]) as u(n, t)
          on conflict (project_id, name) do update
            set entity_type = excluded.entity_type, updated_at = now()
          returning id, name, entity_type, (xmax = 0) as created`;

        const byName = new Map(rows.map((r) => [r.name, r.id]));
        const obsEntities: string[] = [];
        const obsContents: string[] = [];
        for (const e of input) {
          for (const content of e.observations ?? []) {
            obsEntities.push(byName.get(e.name.trim())!);
            obsContents.push(content);
          }
        }

        let observationsAdded = 0;
        if (obsContents.length > 0) {
          const inserted = await tx<{ id: string }[]>`
            insert into public.observations (entity_id, project_id, content, created_by)
            select u.e::uuid, ${project.id}::uuid, u.c, ${ctx.caller.employeeLabel}
            from unnest(${obsEntities}::text[], ${obsContents}::text[]) as u(e, c)
            returning id`;
          observationsAdded = inserted.length;
        }

        return {
          project: project.name,
          created: rows.filter((r) => r.created).map((r) => r.name),
          updated: rows.filter((r) => !r.created).map((r) => r.name),
          observations_added: observationsAdded,
        };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "create_relations",
    title: "Create relations",
    description:
      "Link entities in bulk. Write relation_type in the active voice so the " +
      "edge reads as a sentence: 'AuthService depends_on TokenStore'. Both " +
      "endpoints must already exist. Duplicate edges are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        relations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Name of the source entity." },
              to: { type: "string", description: "Name of the target entity." },
              relation_type: {
                type: "string",
                description:
                  "Active voice, snake_case: depends_on, calls, owns, " +
                  "implements, tested_by, documented_in.",
              },
            },
            required: ["from", "to", "relation_type"],
            additionalProperties: false,
          },
        },
        project: PROJECT_ARG,
      },
      required: ["relations"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const input = arr<{ from: string; to: string; relation_type: string }>(
        args.relations,
        "relations",
      );
      const froms = input.map((r) => str(r.from, "relations[].from"));
      const tos = input.map((r) => str(r.to, "relations[].to"));
      const kinds = input.map((r) => str(r.relation_type, "relations[].relation_type"));

      return ctx.run(project.id, async (tx) => {
        const byName = await assertEntitiesExist(tx, project.id, [...froms, ...tos]);
        const fromIds = froms.map((n) => byName.get(n)!);
        const toIds = tos.map((n) => byName.get(n)!);

        const rows = await tx<{ id: string }[]>`
          insert into public.relations
            (project_id, from_entity_id, to_entity_id, relation_type)
          select ${project.id}::uuid, u.f::uuid, u.t::uuid, u.k
          from unnest(${fromIds}::text[], ${toIds}::text[], ${kinds}::text[])
            as u(f, t, k)
          on conflict on constraint relations_unique_edge do nothing
          returning id`;

        return {
          project: project.name,
          created: rows.length,
          skipped_as_duplicate: input.length - rows.length,
        };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "add_observations",
    title: "Add observations",
    description:
      "Attach facts to existing entities in bulk. One observation per " +
      "discrete fact -- short, self-contained statements search better than " +
      "paragraphs. Stamped with the calling token's employee label.",
    inputSchema: {
      type: "object",
      properties: {
        observations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              entity: { type: "string", description: "Name of an existing entity." },
              contents: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description: "Facts to attach.",
              },
            },
            required: ["entity", "contents"],
            additionalProperties: false,
          },
        },
        project: PROJECT_ARG,
      },
      required: ["observations"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const input = arr<{ entity: string; contents: string[] }>(
        args.observations,
        "observations",
      );

      const entityNames: string[] = [];
      const contents: string[] = [];
      for (const item of input) {
        const name = str(item.entity, "observations[].entity");
        for (const c of arr<string>(item.contents, "observations[].contents")) {
          entityNames.push(name);
          contents.push(str(c, "observations[].contents[]"));
        }
      }

      return ctx.run(project.id, async (tx) => {
        const byName = await assertEntitiesExist(tx, project.id, entityNames);
        const entityIds = entityNames.map((n) => byName.get(n)!);

        const rows = await tx<{ id: string }[]>`
          insert into public.observations (entity_id, project_id, content, created_by)
          select u.e::uuid, ${project.id}::uuid, u.c, ${ctx.caller.employeeLabel}
          from unnest(${entityIds}::text[], ${contents}::text[]) as u(e, c)
          returning id`;

        // Adding a fact about an entity counts as touching it.
        await tx`
          update public.entities set updated_at = now()
          where id = any(${[...new Set(entityIds)]})`;

        return { project: project.name, observations_added: rows.length };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "delete_entities",
    title: "Delete entities",
    description:
      "Remove entities by name, along with their observations and any " +
      "relations touching them. Names that do not exist are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        names: { type: "array", minItems: 1, items: { type: "string" } },
        project: PROJECT_ARG,
      },
      required: ["names"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const names = arr<string>(args.names, "names").map((n) => str(n, "names[]"));

      return ctx.run(project.id, async (tx) => {
        const rows = await tx<{ name: string }[]>`
          delete from public.entities where name = any(${names}) returning name`;
        return {
          project: project.name,
          deleted: rows.map((r) => r.name),
          not_found: names.filter((n) => !rows.some((r) => r.name === n)),
        };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "delete_relations",
    title: "Delete relations",
    description: "Remove specific edges. Edges that do not exist are ignored.",
    inputSchema: {
      type: "object",
      properties: {
        relations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              relation_type: { type: "string" },
            },
            required: ["from", "to", "relation_type"],
            additionalProperties: false,
          },
        },
        project: PROJECT_ARG,
      },
      required: ["relations"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const input = arr<{ from: string; to: string; relation_type: string }>(
        args.relations,
        "relations",
      );
      const froms = input.map((r) => str(r.from, "relations[].from"));
      const tos = input.map((r) => str(r.to, "relations[].to"));
      const kinds = input.map((r) => str(r.relation_type, "relations[].relation_type"));

      return ctx.run(project.id, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          delete from public.relations r
          using unnest(${froms}::text[], ${tos}::text[], ${kinds}::text[]) as u(f, t, k),
                public.entities ef, public.entities et
          where ef.id = r.from_entity_id and et.id = r.to_entity_id
            and ef.name = u.f and et.name = u.t and r.relation_type = u.k
          returning r.id`;
        return {
          project: project.name,
          deleted: rows.length,
          not_found: input.length - rows.length,
        };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "delete_observations",
    title: "Delete observations",
    description:
      "Remove specific observations from an entity, by observation id (as " +
      "returned by search_nodes) or by exact content match. Use this to " +
      "retract facts that have become wrong.",
    inputSchema: {
      type: "object",
      properties: {
        deletions: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              entity: { type: "string" },
              observation_ids: { type: "array", items: { type: "string" } },
              contents: {
                type: "array",
                items: { type: "string" },
                description: "Exact observation text to remove.",
              },
            },
            required: ["entity"],
            additionalProperties: false,
          },
        },
        project: PROJECT_ARG,
      },
      required: ["deletions"],
      additionalProperties: false,
    },
    async handler(args, ctx) {
      const project = await ctx.resolveProject(args.project as string | undefined);
      const input = arr<
        { entity: string; observation_ids?: string[]; contents?: string[] }
      >(args.deletions, "deletions");

      return ctx.run(project.id, async (tx) => {
        let deleted = 0;
        for (const item of input) {
          const entity = str(item.entity, "deletions[].entity");
          const ids = item.observation_ids ?? [];
          const contents = item.contents ?? [];
          if (ids.length === 0 && contents.length === 0) {
            throw new ToolError(
              `deletions for "${entity}" must give observation_ids, contents, or both.`,
            );
          }
          const rows = await tx<{ id: string }[]>`
            delete from public.observations o
            using public.entities e
            where e.id = o.entity_id
              and e.name = ${entity}
              and (o.id = any(${ids}::uuid[]) or o.content = any(${contents}::text[]))
            returning o.id`;
          deleted += rows.length;
        }
        return { project: project.name, observations_deleted: deleted };
      });
    },
  },

  // -------------------------------------------------------------------------
  {
    name: "list_projects",
    title: "List accessible projects",
    description:
      "List the projects this token may read and write, with their entity " +
      "counts. Call this first when you are unsure which project to target.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx) {
      const projects = await ctx.projects();
      const counts = await Promise.all(
        projects.map((p) =>
          ctx.run(p.id, async (tx) => {
            const [row] = await tx<{ entities: number; relations: number }[]>`
              select (select count(*)::int from public.entities)  as entities,
                     (select count(*)::int from public.relations) as relations`;
            return { ...p, ...row };
          })
        ),
      );
      return { employee: ctx.caller.employeeLabel, projects: counts };
    },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

/** The shape `tools/list` returns -- handlers stripped. */
export const TOOL_DESCRIPTORS = TOOLS.map(({ name, title, description, inputSchema }) => ({
  name,
  title,
  description,
  inputSchema,
}));
