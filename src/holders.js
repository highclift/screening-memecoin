// Top-holder concentration via standard Solana JSON-RPC (getTokenLargestAccounts + getTokenSupply).
// Only used when SOLANA_RPC_URL is set. Public RPC endpoints rate-limit these calls, so a provider
// endpoint is recommended. Errors never include the RPC URL (it can contain an API key).

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function amountOf(account) {
  return Number(account?.uiAmountString ?? account?.uiAmount);
}

// Percent of supply held by the next `topCount` accounts. By default the single largest account
// is skipped: right after migration it is usually the AMM pool vault, not a person. That is a
// heuristic (a real whale can be the largest account); set TOP_HOLDERS_SKIP_LARGEST=false to
// count it.
export function topHolderPct(accounts, supply, { topCount = 5, skipLargest = true } = {}) {
  if (!Array.isArray(accounts) || !(supply > 0)) return null;
  const amounts = accounts.map(amountOf).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => b - a);
  const considered = skipLargest ? amounts.slice(1) : amounts;
  const top = considered.slice(0, topCount).reduce((sum, n) => sum + n, 0);
  return (top / supply) * 100;
}

async function rpc(url, method, params, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    if (res.status === 429) {
      const error = new Error("RPC rate limited (429)");
      error.rateLimited = true;
      throw error;
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json();
    if (json?.error) throw new Error(`RPC error: ${String(json.error.message ?? "unknown").slice(0, 120)}`);
    return json?.result;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchHolderStats(mint, rpcUrl, { topCount = 5, skipLargest = true, fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!rpcUrl) throw new Error("no RPC url configured");
  if (typeof mint !== "string" || !MINT_RE.test(mint)) throw new Error("invalid mint address");

  const [largest, supplyResult] = await Promise.all([
    rpc(rpcUrl, "getTokenLargestAccounts", [mint], fetchImpl, timeoutMs),
    rpc(rpcUrl, "getTokenSupply", [mint], fetchImpl, timeoutMs),
  ]);
  const accounts = largest?.value;
  const supply = amountOf(supplyResult?.value);
  if (!Array.isArray(accounts) || !(supply > 0)) throw new Error("RPC returned no holder data");

  const amounts = accounts.map(amountOf).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
  return {
    topPct: topHolderPct(accounts, supply, { topCount, skipLargest }),
    largestPct: amounts.length ? (amounts[0] / supply) * 100 : null,
    accounts: accounts.length,
  };
}
