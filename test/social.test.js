import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedMetadataUri, fetchTokenMetadata, parseSocials } from "../src/social.js";

test("allows https URIs on allowlisted hosts and their subdomains", () => {
  assert.equal(isAllowedMetadataUri("https://ipfs.io/ipfs/bafy123"), true);
  assert.equal(isAllowedMetadataUri("https://my-gateway.mypinata.cloud/ipfs/abc"), true);
  assert.equal(isAllowedMetadataUri("https://arweave.net/xyz"), true);
});

test("blocks internal addresses, other hosts, lookalike hosts and odd URL forms", () => {
  for (const uri of [
    "http://127.0.0.1:3000/api/state",
    "http://localhost/anything",
    "https://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://192.168.1.1/admin",
    "http://ipfs.io/ipfs/abc", // not https
    "https://ipfs.io.evil.com/x", // allowlisted name as a prefix
    "https://evilipfs.io/x", // allowlisted name as a suffix without a dot boundary
    "https://ipfs.io:8443/x", // non-default port
    "https://user:pass@ipfs.io/x", // credentials in URL
    "file:///etc/passwd",
    "not a url",
    "",
  ]) {
    assert.equal(isAllowedMetadataUri(uri), false, uri);
  }
});

test("a custom host list replaces the defaults", () => {
  assert.equal(isAllowedMetadataUri("https://ipfs.io/x", ["example.com"]), false);
  assert.equal(isAllowedMetadataUri("https://meta.example.com/x", ["example.com"]), true);
});

test("fetchTokenMetadata never calls fetch for a disallowed host", async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return new Response("{}");
  };
  await assert.rejects(() => fetchTokenMetadata("http://127.0.0.1:3000/api/stop", fetchImpl), (error) => {
    assert.equal(error.permanent, true);
    assert.match(error.message, /not allowed/);
    return true;
  });
  assert.equal(called, false);
});

test("fetchTokenMetadata refuses redirects and returns parsed JSON for allowed hosts", async () => {
  let options;
  const fetchImpl = async (_uri, init) => {
    options = init;
    return new Response(JSON.stringify({ twitter: "https://x.com/someone" }), { headers: { "content-type": "application/json" } });
  };
  const meta = await fetchTokenMetadata("https://ipfs.io/ipfs/abc", fetchImpl);
  assert.equal(options.redirect, "error");
  assert.equal(parseSocials(meta).twitter, "https://x.com/someone");
});

test("fetchTokenMetadata rejects oversized bodies", async () => {
  const huge = JSON.stringify({ filler: "x".repeat(200 * 1024) });
  const fetchImpl = async () => new Response(huge);
  await assert.rejects(() => fetchTokenMetadata("https://ipfs.io/ipfs/big", fetchImpl), /too large/);
});

test("fetchTokenMetadata surfaces HTTP errors as retryable (not permanent)", async () => {
  const fetchImpl = async () => new Response("nope", { status: 503 });
  await assert.rejects(() => fetchTokenMetadata("https://ipfs.io/ipfs/abc", fetchImpl), (error) => {
    assert.notEqual(error.permanent, true);
    assert.match(error.message, /HTTP 503/);
    return true;
  });
});
