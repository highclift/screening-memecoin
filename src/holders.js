// On-chain safety checks via standard Solana JSON-RPC. Only used when SOLANA_RPC_URL is set.
// Public RPC endpoints rate-limit these calls, so a provider endpoint is recommended. Errors never
// include the RPC URL (it can contain an API key).
//
// What these answer, and why each one exists:
//   concentration   — can one holder dump more than the pool can absorb? This is what kills a
//                     position with no chance to exit: a sell of ~11x the pool's token reserve
//                     drops the price 99% in a single transaction, with no price in between for a
//                     stop to trigger on.
//   mint authority  — can the creator still print more supply?
//   freeze authority— can the creator freeze your tokens so you cannot sell at all?
//   fresh wallets   — were the top holders created minutes ago? A spread of brand-new wallets is
//                     one actor holding the supply through many addresses, not real distribution.

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Accounts owned by this are plain wallets; anything else is a program account (a pool vault,
// a vesting contract, an escrow).
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

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

// Is this wallet brand new? `signatures` is what getSignaturesForAddress returned, newest first,
// asked for with `limit`.
//   fewer than `limit` results  -> that is the wallet's whole history, so we know its age exactly
//   exactly `limit` results     -> there may be more, but if even the oldest of them is recent the
//                                  wallet is new and busy, which is what a sniper looks like
export function isFreshWallet(signatures, { limit, maxTx, maxAgeHours, now = Date.now() } = {}) {
  if (!Array.isArray(signatures)) return null; // unknown, never counted against the coin
  const count = signatures.length;
  if (count === 0) return true; // no history at all
  const oldest = signatures[count - 1]?.blockTime;
  const ageHours = Number.isFinite(oldest) ? (now / 1000 - oldest) / 3600 : null;

  if (count < limit) {
    if (count <= maxTx) return true;
    return ageHours !== null && ageHours < maxAgeHours;
  }
  // A full page: busy. Only "new" if everything it has ever done fits inside the window.
  return ageHours !== null && ageHours < maxAgeHours;
}

// Everything bot 2 wants to know about a coin from the chain itself, in one go.
// Roughly 3 + N calls, where N is the number of holders checked, so it is only worth spending on
// a coin that has already passed everything cheaper.
export async function fetchSafetyReport(mint, rpcUrl, {
  topCount = 5,
  skipLargest = true,
  freshWalletLimit = 50,
  freshWalletMaxTx = 8,
  freshWalletMaxAgeHours = 24,
  fetchImpl = fetch,
  timeoutMs = 8000,
  now = Date.now(),
} = {}) {
  if (!rpcUrl) throw new Error("no RPC url configured");
  if (typeof mint !== "string" || !MINT_RE.test(mint)) throw new Error("invalid mint address");

  const [mintInfo, largest, supplyResult] = await Promise.all([
    rpc(rpcUrl, "getAccountInfo", [mint, { encoding: "jsonParsed" }], fetchImpl, timeoutMs),
    rpc(rpcUrl, "getTokenLargestAccounts", [mint], fetchImpl, timeoutMs),
    rpc(rpcUrl, "getTokenSupply", [mint], fetchImpl, timeoutMs),
  ]);

  const accounts = largest?.value;
  const supply = amountOf(supplyResult?.value);
  if (!Array.isArray(accounts) || !(supply > 0)) throw new Error("RPC returned no holder data");

  const parsed = mintInfo?.value?.data?.parsed?.info ?? {};
  // The RPC reports a revoked authority as null; anything else means it is still live.
  const mintAuthority = parsed.mintAuthority ?? null;
  const freezeAuthority = parsed.freezeAuthority ?? null;

  const ranked = [...accounts]
    .map((account) => ({ address: account?.address, amount: amountOf(account) }))
    .filter((account) => account.address && Number.isFinite(account.amount))
    .sort((a, b) => b.amount - a.amount);

  // Token accounts are not wallets: one call turns them into the owners behind them, and a second
  // says what each owner IS. A person's wallet is owned by the System Program; a pool vault is
  // owned by the DEX program that runs the pool. That distinction matters more than it sounds:
  // assuming "the biggest holder is the pool" hides a whale holding nearly all the supply, which
  // is the one thing most worth knowing.
  const candidates = ranked.slice(0, topCount + 1);
  let owners = [];
  let isPerson = [];
  if (candidates.length) {
    const accountInfo = await rpc(rpcUrl, "getMultipleAccounts",
      [candidates.map((account) => account.address), { encoding: "jsonParsed" }], fetchImpl, timeoutMs);
    owners = (accountInfo?.value ?? []).map((entry) => entry?.data?.parsed?.info?.owner ?? null);

    const named = owners.filter(Boolean);
    const ownerKinds = new Map();
    if (named.length) {
      const ownerInfo = await rpc(rpcUrl, "getMultipleAccounts", [named, { encoding: "base64" }], fetchImpl, timeoutMs);
      (ownerInfo?.value ?? []).forEach((entry, i) => {
        // A missing account has never been written to, which only a plain wallet can be.
        ownerKinds.set(named[i], !entry || entry.owner === SYSTEM_PROGRAM);
      });
    }
    isPerson = owners.map((owner) => (owner ? ownerKinds.get(owner) ?? null : null));
  }

  // Only real wallets count towards concentration. When the owner could not be classified we fall
  // back to the old assumption for the single largest account rather than guessing it is a person.
  const people = [];
  candidates.forEach((account, i) => {
    const person = isPerson[i];
    const assumePool = person === null && skipLargest && i === 0;
    if (person === false || assumePool) return;
    people.push({ ...account, owner: owners[i] ?? null, pct: (account.amount / supply) * 100 });
  });
  const counted = people.slice(0, topCount);

  const holders = [];
  for (const holder of counted) {
    if (!holder.owner) {
      holders.push({ owner: null, pct: holder.pct, fresh: null });
      continue;
    }
    let fresh = null;
    try {
      const signatures = await rpc(rpcUrl, "getSignaturesForAddress",
        [holder.owner, { limit: freshWalletLimit }], fetchImpl, timeoutMs);
      fresh = isFreshWallet(signatures, {
        limit: freshWalletLimit, maxTx: freshWalletMaxTx, maxAgeHours: freshWalletMaxAgeHours, now,
      });
    } catch {
      fresh = null; // one wallet we could not read must not condemn the coin
    }
    holders.push({ owner: holder.owner, pct: holder.pct, fresh });
  }

  const checked = holders.filter((holder) => holder.fresh !== null);
  const freshHolders = checked.filter((holder) => holder.fresh).length;
  const topPct = counted.reduce((total, holder) => total + holder.pct, 0);

  return {
    // Wallets only. A pool vault holding most of the supply is normal and not counted.
    topPct,
    largestHolderPct: counted.length ? counted[0].pct : null,
    largestPct: ranked.length ? (ranked[0].amount / supply) * 100 : null,
    accounts: accounts.length,
    mintAuthority,
    freezeAuthority,
    holders,
    checkedHolders: checked.length,
    freshHolders,
    freshPct: checked.length ? (freshHolders / checked.length) * 100 : null,
  };
}
