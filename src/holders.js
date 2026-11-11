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
//   linked wallets  — the bubble map. Who PAID to create each holding wallet? Holders that share a
//                     funder are one actor, and splitting a position across twenty addresses is
//                     done for exactly one reason: to sit under a concentration limit. The funding
//                     TIMES are kept too, because wallets paid for within hours of each other were
//                     set up for this coin, which is what separates an insider cluster from a row
//                     of strangers who all happened to withdraw from the same exchange.

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Accounts owned by this are plain wallets; anything else is a program account (a pool vault,
// a vesting contract, an escrow).
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
// Highest transaction version we ask the RPC to hand back. See the note in fetchFunder: asking for
// too low a number does not downgrade the answer, it refuses it.
const MAX_TX_VERSION = 1;

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
// Roughly 3 + 2N calls, where N is `clusterHolderCount` — every holder costs a history lookup, and
// most of them a second call to read who funded them. That is the most expensive thing in the
// pipeline, so it is only spent on a coin that has already passed everything cheaper.
//
// `topCount` is how many holders count towards concentration; `clusterHolderCount` is how many are
// walked for the funding graph. They differ on purpose: a cluster of twenty wallets at 1.5% each is
// invisible to any top-5 check, and that is the shape this is here to catch.
export async function fetchSafetyReport(mint, rpcUrl, {
  topCount = 5,
  clusterHolderCount = 20,
  skipLargest = true,
  freshWalletLimit = 50,
  freshWalletMaxTx = 8,
  freshWalletMaxAgeHours = 24,
  // How many holders may cost a second, bigger history page to find their first transaction (see
  // fetchOldestSignature). Holders are walked biggest first, so the budget is spent where a hidden
  // link would matter most, and a coin held by busy bot wallets cannot run up 20 wasted pages.
  maxDeepLookups = 8,
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
  const walked = Math.max(topCount, clusterHolderCount);
  const candidates = ranked.slice(0, walked + 1);
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
  // Concentration is judged on the top `topCount` holders; the funding graph is walked over every
  // holder we can see, because the cluster being looked for is deliberately too small to show up
  // in a top-5 check.
  const counted = people.slice(0, topCount);
  const walking = people.slice(0, walked);

  const holders = [];
  let deepLookups = 0;
  for (const holder of walking) {
    if (!holder.owner) {
      holders.push({ owner: null, pct: holder.pct, fresh: null, funder: null, fundedAt: null });
      continue;
    }
    let fresh = null;
    let funder = null;
    let fundedAt = null;
    try {
      const signatures = await rpc(rpcUrl, "getSignaturesForAddress",
        [holder.owner, { limit: freshWalletLimit }], fetchImpl, timeoutMs);
      fresh = isFreshWallet(signatures, {
        limit: freshWalletLimit, maxTx: freshWalletMaxTx, maxAgeHours: freshWalletMaxAgeHours, now,
      });

      // Who paid to bring this wallet to life? A new wallet cannot pay its own first fee, so
      // whoever signed its oldest transaction funded it. When several holders share that payer
      // they are one actor spread across addresses — the clusters you see on a bubble map.
      const full = Array.isArray(signatures) && signatures.length >= freshWalletLimit;
      if (full) deepLookups += 1;
      const oldest = full && deepLookups > maxDeepLookups
        ? null
        : await fetchOldestSignature(holder.owner, signatures, freshWalletLimit, rpcUrl, fetchImpl, timeoutMs);
      if (oldest) {
        fundedAt = Number.isFinite(oldest.blockTime) ? oldest.blockTime * 1000 : null;
        funder = await fetchFunder(oldest.signature, holder.owner, rpcUrl, fetchImpl, timeoutMs);
      }
    } catch {
      fresh = null; // one wallet we could not read must not condemn the coin
    }
    holders.push({ owner: holder.owner, pct: holder.pct, fresh, funder, fundedAt });
  }

  // Group the holders by who funded them. A funder that is itself one of the holders joins its own
  // group: on a bubble map that is the hub in the middle, which holds tokens as well as handing
  // them out, and leaving it out understates exactly the position that gets dumped.
  const byOwner = new Map(holders.filter((holder) => holder.owner).map((holder) => [holder.owner, holder]));
  const byFunder = new Map();
  for (const holder of holders) {
    if (!holder.funder) continue;
    let group = byFunder.get(holder.funder);
    if (!group) {
      group = new Map();
      const hub = byOwner.get(holder.funder);
      if (hub) group.set(hub.owner, hub);
      byFunder.set(holder.funder, group);
    }
    group.set(holder.owner, holder);
  }

  const clusters = [...byFunder.entries()]
    .filter(([, members]) => members.size >= 2)
    .map(([funder, members]) => {
      const group = [...members.values()];
      const times = group.map((member) => member.fundedAt).filter((at) => Number.isFinite(at));
      return {
        funder,
        wallets: group.length,
        pct: group.reduce((total, member) => total + member.pct, 0),
        // How long the setup took. Wallets paid for within hours of each other were created for
        // this coin; a span of months is an address many unrelated people happen to share, such as
        // an exchange's hot wallet, and that is not evidence of anything.
        spanHours: times.length >= 2 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : null,
      };
    })
    .sort((a, b) => b.pct - a.pct);

  // Every cluster together, counting each wallet once. The picture that prompted this has several
  // hubs rather than one, so the largest cluster alone understates how much supply is spoken for.
  const linked = new Map();
  for (const members of byFunder.values()) {
    if (members.size < 2) continue;
    for (const member of members.values()) linked.set(member.owner, member.pct);
  }
  const fundersKnown = holders.some((holder) => holder.funder);

  const checked = holders.slice(0, topCount).filter((holder) => holder.fresh !== null);
  const freshHolders = checked.filter((holder) => holder.fresh).length;
  const topPct = counted.reduce((total, holder) => total + holder.pct, 0);
  // What matters is how much SUPPLY sits in new wallets, not how many of them there are. On a
  // young memecoin nearly every holder is a new wallet; five new wallets holding 1% between them
  // are harmless, while two holding 40% are the whole risk.
  const freshSupplyPct = checked.reduce((total, holder) => total + (holder.fresh ? holder.pct : 0), 0);

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
    freshSupplyPct: checked.length ? freshSupplyPct : null,
    clusters,
    // The biggest group of holders that one wallet paid to create, as a share of supply.
    largestClusterPct: clusters.length ? clusters[0].pct : null,
    largestClusterWallets: clusters.length ? clusters[0].wallets : 0,
    // Hours between the first and last of those wallets being funded. null when unknown.
    largestClusterSpanHours: clusters.length ? clusters[0].spanHours : null,
    // All clusters at once, each wallet counted once. null (not 0) when no funder could be read
    // at all, so "nobody is linked" is never confused with "we could not tell".
    linkedSupplyPct: fundersKnown ? [...linked.values()].reduce((total, pct) => total + pct, 0) : null,
    linkedWallets: linked.size,
    walkedHolders: holders.length,
  };
}

// A wallet's FIRST transaction, which is the one somebody else paid for.
//
// The freshness page is deliberately small (50 by default), and on these coins it is nearly always
// full: a sniper wallet does dozens of trades the day it is made. A full page used to mean the
// first transaction was out of reach and the wallet was left unlinked — which is how a map of
// twenty wallets around one funder came back showing no links at all. So when the page is full,
// one more call asks for the whole history (the RPC allows 1000 per page, far more than any wallet
// of this kind has) and the last entry of that is the first thing the wallet ever did.
//
// A wallet with more than ~1050 transactions is left unlinked. That is the honest answer: nobody
// sets up a throwaway holding wallet and then runs a thousand transactions through it.
async function fetchOldestSignature(owner, signatures, pageLimit, rpcUrl, fetchImpl, timeoutMs) {
  if (!Array.isArray(signatures) || !signatures.length) return null;
  if (signatures.length < pageLimit) return signatures[signatures.length - 1];

  const before = signatures[signatures.length - 1]?.signature;
  if (!before) return null;
  const rest = await rpc(rpcUrl, "getSignaturesForAddress",
    [owner, { limit: 1000, before }], fetchImpl, timeoutMs);
  if (!Array.isArray(rest)) return null;
  if (!rest.length) return signatures[signatures.length - 1]; // the first page was the whole story
  return rest.length < 1000 ? rest[rest.length - 1] : null;
}

// The signer of a wallet's oldest transaction, which is whoever funded it. Returns null for
// anything ambiguous — a wrong answer here would group unrelated holders together.
async function fetchFunder(signature, owner, rpcUrl, fetchImpl, timeoutMs) {
  if (!signature) return null;
  try {
    // maxSupportedTransactionVersion has to cover the versions actually in use: the RPC REFUSES a
    // transaction newer than what the caller says it understands, rather than returning it. Asking
    // for 0 (legacy only) meant every modern router/swap transaction came back as an error, which
    // this function reported as "no funder" — so the funding graph was mostly blank, and the
    // clusters it exists to find never formed.
    const tx = await rpc(rpcUrl, "getTransaction",
      [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: MAX_TX_VERSION }], fetchImpl, timeoutMs);
    const keys = tx?.transaction?.message?.accountKeys;
    if (!Array.isArray(keys) || !keys.length) return null;
    // The fee payer is the first key. If the wallet paid for itself it was already funded by
    // something we cannot see from here, so there is nothing to report.
    const payer = typeof keys[0] === "string" ? keys[0] : keys[0]?.pubkey;
    return payer && payer !== owner ? payer : null;
  } catch {
    return null;
  }
}
