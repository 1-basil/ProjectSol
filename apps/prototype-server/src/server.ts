import { createServer } from "node:http";
import { getConnection } from "./solana/connection.ts";
import { openDatabase } from "./db/client.ts";
import { loadPooledWallet, assertDistinctFromPooledWallet } from "./solana/pooledWallet.ts";
import { verifyNetworkIdentity, assertAllowlistOverrideNotUsedOnMainnet } from "./solana/networkIdentity.ts";
import { startIndexer } from "./indexer/index.ts";
import { createHttpHandler } from "./httpHandler.ts";
import { COMPANY_RECEIVING_WALLET } from "./solana/companyReceivingWallet.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? "./prototype.db";
const INDEXER_INTERVAL_MS = Number(process.env.INDEXER_INTERVAL_MS ?? 4000);
const DISABLE_INDEXER = process.env.DISABLE_INDEXER === "true"; // for tests/tools that only need the HTTP API
// Defaults to "devnet" to match connection.ts's own default RPC URL -- an
// operator who sets SOLANA_RPC_URL to a different network MUST also set
// this, or startup fails closed below (a mismatch is refused, never a
// mismatch left unchecked).
const EXPECTED_SOLANA_NETWORK = process.env.EXPECTED_SOLANA_NETWORK ?? "devnet";

// Fail closed before anything else: a devnet-only test hook must never
// reach a mainnet process, regardless of how ALLOWLIST_VERSION_OVERRIDE
// ended up in this process's environment (leaked CI var, copied .env,
// shared shell profile). Checked synchronously, before any network call.
assertAllowlistOverrideNotUsedOnMainnet(EXPECTED_SOLANA_NETWORK, process.env.ALLOWLIST_VERSION_OVERRIDE);

const db = openDatabase(DB_PATH);
const connection = getConnection();
const pooledWallet = loadPooledWallet();

// The fixed company receiving wallet must never coincide with the pooled
// (delegate/signing) wallet -- they play deliberately different roles
// (destination vs. signer). Reuses the same distinctness assertion already
// used for client/pooled in the devnet harness; catches a real
// misconfiguration (e.g. POOLED_WALLET_KEYPAIR_PATH accidentally pointing
// at a keypair for this exact address) at startup rather than silently
// collapsing back to the pre-company-wallet architecture.
assertDistinctFromPooledWallet(pooledWallet.publicKey, COMPANY_RECEIVING_WALLET, "COMPANY_RECEIVING_WALLET");

// Fail closed before anything else can happen: never start the indexer or
// accept a single HTTP request against an RPC endpoint that isn't
// genuinely the expected network. This is a live check against the
// cluster's own genesis hash -- not a trust of the SOLANA_RPC_URL string.
const networkIdentity = await verifyNetworkIdentity(connection, EXPECTED_SOLANA_NETWORK);
console.log(`network identity verified: ${networkIdentity.expectedNetwork} (genesis ${networkIdentity.liveGenesisHash})`);

let stopIndexer: (() => void) | null = null;
if (!DISABLE_INDEXER) {
  stopIndexer = startIndexer({ connection, db, pooledWallet }, INDEXER_INTERVAL_MS);
}

process.on("SIGINT", () => {
  stopIndexer?.();
  process.exit(0);
});

const server = createServer(createHttpHandler({ connection, db, pooledWallet }));

server.listen(PORT, () => {
  console.log(`prototype-server listening on :${PORT} (db: ${DB_PATH})`);
});
