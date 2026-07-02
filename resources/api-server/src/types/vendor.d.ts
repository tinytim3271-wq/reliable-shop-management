// Ambient type declarations for two small CommonJS helpers that ship no types
// and have no @types package. Both are already in the dependency tree as
// transitive deps of express-session; we depend on them directly (see
// package.json) so esbuild can bundle them and the desktop header-session
// transport can sign/emit the session id exactly like express-session does.

declare module "cookie-signature" {
  // Signs `value` with `secret`, returning `<value>.<base64-hmac>`. This is the
  // same routine express-session uses, so a value produced here round-trips
  // through express-session's own verifier when injected as the session cookie.
  export function sign(value: string, secret: string): string;
  // Returns the original value if the signature is valid, otherwise `false`.
  export function unsign(input: string, secret: string): string | false;
}

declare module "on-headers" {
  import type { ServerResponse } from "node:http";
  // Registers a listener invoked synchronously just before response headers are
  // written, when the final session id (after any login regeneration) is known.
  function onHeaders(
    res: ServerResponse,
    listener: (this: ServerResponse) => void,
  ): void;
  export = onHeaders;
}
