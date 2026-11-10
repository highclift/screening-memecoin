// Social-link filter. Reads the links the token creator put in the Pump.fun metadata
// (twitter / telegram / website). IMPORTANT: this only proves a link was filled in,
// not that the account is real or that the dev is honest. It removes lazy launches only.

const X_URL = /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/(i\/communities\/\d+|[A-Za-z0-9_]{1,15}(\/status\/\d+)?)\/?(\?.*)?$/i;
const TG_URL = /^https?:\/\/(www\.)?(t\.me|telegram\.me)\/[A-Za-z0-9_+\/-]{3,}\/?$/i;
const WEB_URL = /^https?:\/\/[^\s/$.?#]+\.[^\s]{2,}$/i;
const NOT_A_SITE = /(pump\.fun|ipfs\.io|dexscreener\.com|solscan\.io)/i;

// The metadata URI comes from the token creator, i.e. from an untrusted party. Fetching an
// arbitrary URL would let a creator make this machine request internal addresses (localhost,
// LAN devices, cloud metadata endpoints). Only these hosts (and their subdomains) are fetched.
// Override with METADATA_HOSTS=host1,host2 in .env.
export const DEFAULT_METADATA_HOSTS = [
  "ipfs.io",
  "cf-ipfs.com",
  "cloudflare-ipfs.com",
  "gateway.pinata.cloud",
  "mypinata.cloud",
  "nftstorage.link",
  "dweb.link",
  "arweave.net",
];
const MAX_METADATA_BYTES = 64 * 1024;

function clean(value) {
  return typeof value === "string" ? value.trim().slice(0, 300) : "";
}

export function parseSocials(meta) {
  if (!meta || typeof meta !== "object") return null;
  const twitter = clean(meta.twitter);
  const telegram = clean(meta.telegram);
  const website = clean(meta.website);
  return {
    twitter: X_URL.test(twitter) ? twitter : "",
    telegram: TG_URL.test(telegram) ? telegram : "",
    website: WEB_URL.test(website) && !NOT_A_SITE.test(website) ? website : "",
  };
}

// Merge DexScreener "info" ({socials:[{type,url}], websites:[{url}]}) into the same shape.
export function parseDexInfo(info) {
  if (!info || typeof info !== "object") return null;
  const socials = Array.isArray(info.socials) ? info.socials : [];
  const find = (type) => socials.find((s) => String(s?.type).toLowerCase() === type)?.url;
  return parseSocials({
    twitter: find("twitter"),
    telegram: find("telegram"),
    website: Array.isArray(info.websites) ? info.websites[0]?.url : "",
  });
}

export function mergeSocials(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    twitter: a.twitter || b.twitter,
    telegram: a.telegram || b.telegram,
    website: a.website || b.website,
  };
}

// Returns "pass" | "fail" | "unknown"
export function socialVerdict(mode, social) {
  if (mode === "off") return "pass";
  if (!social) return "unknown";
  if (mode === "twitter") return social.twitter ? "pass" : "fail";
  const links = [social.twitter, social.telegram, social.website].filter(Boolean).length;
  if (mode === "multiple") return links >= 2 ? "pass" : "unknown";
  return links >= 1 ? "pass" : "fail";
}

export function isAllowedMetadataUri(uri, hosts = DEFAULT_METADATA_HOSTS) {
  let url;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return hosts.some((allowed) => {
    const name = String(allowed).trim().toLowerCase();
    return name && (host === name || host.endsWith(`.${name}`));
  });
}

function permanentError(message) {
  const error = new Error(message);
  error.permanent = true; // retrying will not help
  return error;
}

async function readLimitedText(res, maxBytes) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw permanentError("metadata response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchTokenMetadata(uri, fetchImpl = fetch, hosts = DEFAULT_METADATA_HOSTS) {
  if (typeof uri !== "string" || !isAllowedMetadataUri(uri, hosts)) {
    let host = "invalid uri";
    try {
      host = new URL(uri).hostname;
    } catch { /* keep default */ }
    throw permanentError(`metadata host not allowed: ${host}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetchImpl(uri, {
      signal: controller.signal,
      redirect: "error", // a redirect could point somewhere that is not allowlisted
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const length = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(length) && length > MAX_METADATA_BYTES) throw permanentError("metadata response too large");
    return JSON.parse(await readLimitedText(res, MAX_METADATA_BYTES));
  } finally {
    clearTimeout(timer);
  }
}
