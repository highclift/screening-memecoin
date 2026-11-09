// Social-link filter. Reads the links the token creator put in the Pump.fun metadata
// (twitter / telegram / website). IMPORTANT: this only proves a link was filled in,
// not that the account is real or that the dev is honest. It removes lazy launches only.

const X_URL = /^https?:\/\/(www\.|mobile\.)?(x|twitter)\.com\/(i\/communities\/\d+|[A-Za-z0-9_]{1,15}(\/status\/\d+)?)\/?(\?.*)?$/i;
const TG_URL = /^https?:\/\/(www\.)?(t\.me|telegram\.me)\/[A-Za-z0-9_+\/-]{3,}\/?$/i;
const WEB_URL = /^https?:\/\/[^\s/$.?#]+\.[^\s]{2,}$/i;
const NOT_A_SITE = /(pump\.fun|ipfs\.io|dexscreener\.com|solscan\.io)/i;

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

export async function fetchTokenMetadata(uri, fetchImpl = fetch) {
  if (typeof uri !== "string" || !/^https?:\/\//i.test(uri)) throw new Error("bad metadata uri");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetchImpl(uri, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
