// The hosted relay's sign-in check, with a key pair made for the test and a fake key endpoint.

import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { verifyAccessToken } from "../src/cognito.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const opts = { region: "us-east-1", poolId: "us-east-1_TEST", clientId: "client-1", fetchImpl: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) };
const issuer = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TEST";

function token(claims, key = privateKey) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const body = `${enc({ alg: "RS256", kid: "k1" })}.${enc(claims)}`;
  const sig = createSign("RSA-SHA256").update(body).sign(key).toString("base64url");
  return `${body}.${sig}`;
}
const good = () => ({ iss: issuer, token_use: "access", client_id: "client-1", username: "judge", exp: Math.floor(Date.now() / 1000) + 600 });

test("accepts a signed, current access token for the right app client", async () => {
  const claims = await verifyAccessToken(token(good()), opts);
  assert.equal(claims.username, "judge");
});

test("refuses a wrong client, an ID token, an expired token or a forged signature", async () => {
  await assert.rejects(verifyAccessToken(token({ ...good(), client_id: "other" }), opts), /claims/);
  await assert.rejects(verifyAccessToken(token({ ...good(), token_use: "id" }), opts), /claims/);
  await assert.rejects(verifyAccessToken(token({ ...good(), exp: 1 }), opts), /expired/);
  const { privateKey: other } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(verifyAccessToken(token(good(), other), opts), /signature/);
  await assert.rejects(verifyAccessToken("not.a.token", opts));
});
