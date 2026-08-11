import { sql } from "./db.ts";

export interface Caller {
  tokenId: string;
  employeeLabel: string;
  projectIds: string[];
}

/** sha256 hex -- must match app.hash_token() in the database. */
export async function hashToken(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Pulls the bearer token out of the request, tolerating the header casings
 *  MCP clients actually send. */
export function extractToken(req: Request): string | null {
  const header = req.headers.get("authorization") ??
    req.headers.get("x-mcp-token");
  if (!header) return null;
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  const raw = (bearer ? bearer[1] : header).trim();
  return raw.length > 0 ? raw : null;
}

/**
 * Resolves a raw token to its caller identity. Returns null for unknown or
 * revoked tokens -- the two are deliberately indistinguishable to the client.
 */
export async function authenticate(rawToken: string): Promise<Caller | null> {
  const rows = await sql<
    { token_id: string; employee_label: string; project_ids: string[] }[]
  >`select * from app.authenticate(${await hashToken(rawToken)})`;

  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    tokenId: row.token_id,
    employeeLabel: row.employee_label,
    projectIds: row.project_ids ?? [],
  };
}
