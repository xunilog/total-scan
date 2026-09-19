// Ambient declarations for the JSR modules used in this repo, so editors using
// TypeScript's language server (tsserver) can resolve `@std/*` specifiers.
//
// `deno check` uses the real JSR types and is the source of truth; this shim
// only covers the small surface this project actually calls.

declare module "@std/assert" {
  export function assertEquals<T>(
    actual: T,
    expected: T,
    msg?: string,
  ): void;
}

declare module "@std/http/file-server" {
  export interface ServeDirOptions {
    readonly fsRoot?: string;
    readonly urlRoot?: string;
    readonly quiet?: boolean;
    readonly showDirListing?: boolean;
    readonly showIndex?: boolean;
  }
  export function serveDir(
    request: Request,
    options?: ServeDirOptions,
  ): Promise<Response>;
}
