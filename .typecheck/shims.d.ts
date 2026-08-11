declare namespace Deno {
  const env: { get(key: string): string | undefined };
  function serve(handler: (req: Request) => Response | Promise<Response>): unknown;
}
declare module "npm:postgres@3.4.5" {
  interface Row { [k: string]: any }
  interface Sql {
    <T = Row[]>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    begin<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  }
  const postgres: (url: string, opts?: Record<string, unknown>) => Sql;
  export default postgres;
}
declare namespace Deno {
  function serve(opts: Record<string, unknown>, handler: (req: Request) => Response | Promise<Response>): unknown;
}
