import { verify } from "../auth/token.js";
export function requireAuth(secret: string) {
  return (headers: Record<string, string>) => {
    const sig = headers["x-signature"];
    const payload = headers["x-payload"];
    if (!sig || !payload || !verify(payload, sig, secret)) throw new Error("unauthorised");
  };
}
