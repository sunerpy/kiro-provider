/**
 * One writer process of the snapshot concurrent-writer test: opens the shared
 * Accounts DB through its own connection, tries to claim every listed pending
 * call and completes the ones it won. Prints the won call ids as JSON. With a
 * group size, consecutive ids are claimed together as one group.
 *
 *   bun __tests__/fixtures/web-search-claim-race.ts <db path> <replay key> <tenant> <ids json> [group size]
 */
import { ConfigSchema } from "../../src/config/schema.js";
import { loadReasoningReplayKeyring } from "../../src/reasoning/keyring.js";
import { AccountsDatabase } from "../../src/storage/accounts-db.js";
import { WebSearchError } from "../../src/web-search/errors.js";
import { WebSearchSnapshotStore } from "../../src/web-search/snapshot-store.js";

const [path, key, tenant, ids, groupSize] = process.argv.slice(2);
if (!path || !key || !tenant || !ids) throw new Error("usage: <db> <key> <tenant> <ids>");
const keyring = loadReasoningReplayKeyring(
  ConfigSchema.parse({ api_keys: ["sk-test"], reasoning_replay_keys: [key] }),
);
const database = new AccountsDatabase(path);
const store = new WebSearchSnapshotStore(database, () => keyring, {
  capacityBytes: 1_048_576,
  reservationBytes: 4_096,
});
const won: string[] = [];
const all = JSON.parse(ids) as string[];
const size = Number(groupSize ?? "1");
for (let index = 0; index < all.length; index += size) {
  const group = all.slice(index, index + size);
  try {
    const claimed =
      size === 1
        ? [store.claim(tenant, group[0] as string, ["deferred"])]
        : store.claimGroup(tenant, group, ["deferred"]);
    for (const snapshot of claimed) {
      store.complete(tenant, snapshot, {
        modelText: '{"results":[]}',
        sources: [],
        retrievedCount: 0,
        filteredCount: 0,
        budgetDroppedCount: 0,
      });
      won.push(snapshot.callId);
    }
  } catch (error) {
    // Losing the race is the typed pending refusal; anything else is a failure.
    if (!(error instanceof WebSearchError) || error.code !== "web_search_replay_pending") {
      throw error;
    }
  }
}
database.close();
process.stdout.write(JSON.stringify(won));
