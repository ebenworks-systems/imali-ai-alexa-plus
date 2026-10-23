// Checks an Amazon Cognito access token the way AgentCore's JWT authorizer does: the signature against the pool's
// published keys, the issuer, the token type, the app client and the expiry. The hosted page's model relay answers
// only callers who passed this check, so the model is never open to anonymous visitors.

import { createPublicKey, createVerify } from "node:crypto";

const cache = new Map();

async function keysFor(issuer, fetchImpl, now) {
  const hit = cache.get(issuer);
  if (hit && now - hit.at < 3_600_000) return hit.keys;
  const res = await fetchImpl(`${issuer}/.well-known/jwks.json`);
  if (!res.ok) throw new Error("no keys");
  const keys = (await res.json()).keys || [];
  cache.set(issuer, { keys, at: now });
  return keys;
}

export async function verifyAccessToken(token, { region, poolId, clientId, fetchImpl = fetch, now = Date.now() }) {
  const [h, p, sig] = String(token || "").split(".");
  if (!h || !p || !sig) throw new Error("malformed");
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${poolId}`;
  if (header.alg !== "RS256") throw new Error("algorithm");
  if (claims.iss !== issuer || claims.token_use !== "access" || claims.client_id !== clientId) throw new Error("claims");
  if (!(claims.exp * 1000 > now)) throw new Error("expired");
  const jwk = (await keysFor(issuer, fetchImpl, now)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("key");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${h}.${p}`);
  if (!verifier.verify(createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(sig, "base64url"))) throw new Error("signature");
  return claims;
}
