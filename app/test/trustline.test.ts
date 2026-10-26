// Trustline add flow: a wallet decline re-prompts once, and the Add trustline
// button stays after any failure. Run: npm test (plain node --test, no bundler).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WalletSignError,
  addTrustlinesWithRetry,
  signOnce,
  trustlineUi,
  type TrustCode,
} from "../src/trustline.ts";

type Balances = Parameters<typeof trustlineUi>[1] & object;

const fresh = (): Balances => ({
  exists: true,
  xlm: 10_000_0000000n,
  usdc: null,
  usdcAuthorized: false,
  tbenji: null,
  tbenjiAuthorized: false,
  tsafo: null,
  tsafoAllowed: false,
});

// Freighter (via Stellar Wallets Kit) rejects with a plain object, not an Error.
const FREIGHTER_DECLINE = { code: -4, message: "User declined access" };

/**
 * A fake account + wallet. `answers` scripts each signature request: "reject" or
 * "sign". A signed tx adds its lines to the account, like chain.addTrustlines does.
 */
function harness(answers: ("reject" | "sign")[], start: Balances = fresh()) {
  const account = { ...start };
  const signRequests: TrustCode[][] = [];
  const deps = {
    balances: async () => ({ ...account }),
    add: async (which: TrustCode[]) => {
      signRequests.push([...which]);
      const answer = answers[signRequests.length - 1] ?? "reject";
      await signOnce(async () => {
        if (answer === "reject") throw FREIGHTER_DECLINE;
        return "signed-xdr";
      });
      for (const c of which) {
        if (c === "USDC") account.usdc = 0n;
        else account.tbenji = 0n;
      }
      return `hash-${signRequests.length}`;
    },
  };
  return { account, signRequests, deps };
}

test("reject -> retry -> success: a declined sign triggers a second sign request", async () => {
  const h = harness(["reject", "sign"]);
  const retried: TrustCode[][] = [];
  const r = await addTrustlinesWithRetry(h.deps, ["USDC", "tBENJI"], { onRetry: (_e, todo) => retried.push(todo) });

  assert.equal(h.signRequests.length, 2, "wallet asked twice");
  assert.deepEqual(retried, [["USDC", "tBENJI"]], "onRetry fired once, before the second request");
  assert.deepEqual(r, { added: ["USDC", "tBENJI"], hash: "hash-2", attempts: 2 });
  assert.equal(h.account.usdc, 0n);
  assert.equal(h.account.tbenji, 0n);
  // Lines are in place, so the gate shows no button any more (issuer authorization is next).
  assert.equal(trustlineUi("wallet", h.account, null).button, null);
});

test("two declines: error surfaces after exactly two requests and the button stays clickable", async () => {
  const h = harness(["reject", "reject", "sign"]);
  const before = trustlineUi("wallet", h.account, null).button;
  assert.ok(before);

  // While the request is in flight (run() sets busy = "trust") the button waits.
  const inFlight = trustlineUi("wallet", h.account, "trust").button;
  assert.deepEqual(inFlight && { label: inFlight.label, disabled: inFlight.disabled }, {
    label: "Waiting for wallet…",
    disabled: true,
  });

  await assert.rejects(addTrustlinesWithRetry(h.deps, ["USDC", "tBENJI"]), (e: unknown) => {
    assert.ok(e instanceof WalletSignError);
    assert.match(e.message, /declined/, "wallet wording kept, so explain() says 'You rejected the request'");
    return true;
  });
  assert.equal(h.signRequests.length, 2, "one automatic re-prompt, no loop");

  // After the failure run() clears busy: same button, enabled, same missing lines.
  const after = trustlineUi("wallet", h.account, null);
  assert.equal(after.gated, true);
  assert.deepEqual(after.button, { missing: ["USDC", "tBENJI"], label: "Add USDC + tBENJI trustlines", disabled: false });

  // A manual click works again (third request is signed).
  const r = await addTrustlinesWithRetry(h.deps, after.button!.missing);
  assert.equal(r.hash, "hash-3");
  assert.equal(h.signRequests.length, 3);
});

test("retry re-reads the account and asks only for lines still missing", async () => {
  const h = harness(["reject", "sign"]);
  const r = await addTrustlinesWithRetry(h.deps, ["USDC", "tBENJI"], {
    // e.g. the USDC line landed from another tab between the two prompts
    onRetry: () => (h.account.usdc = 0n),
  });
  assert.deepEqual(h.signRequests, [["USDC", "tBENJI"], ["tBENJI"]]);
  assert.deepEqual(r.added, ["tBENJI"]);
});

test("lines already in place: no wallet prompt", async () => {
  const h = harness([], { ...fresh(), usdc: 5n, tbenji: 0n });
  const r = await addTrustlinesWithRetry(h.deps, ["USDC", "tBENJI"]);
  assert.deepEqual(r, { added: [], hash: null, attempts: 0 });
  assert.equal(h.signRequests.length, 0);
});

test("non-wallet failures (submit error) are not re-prompted", async () => {
  let calls = 0;
  await assert.rejects(
    addTrustlinesWithRetry(
      {
        balances: async () => fresh(),
        add: async () => {
          calls++;
          throw new Error("Trustline tx rejected: txInsufficientBalance");
        },
      },
      ["USDC"],
    ),
    /txInsufficientBalance/,
  );
  assert.equal(calls, 1);
});

test("account not on testnet: clear error, no prompt", async () => {
  const h = harness([], { ...fresh(), exists: false });
  await assert.rejects(addTrustlinesWithRetry(h.deps, ["USDC"]), /friendbot/);
  assert.equal(h.signRequests.length, 0);
});

test("a wallet that never answers times out with a plain Error (no auto re-prompt)", async () => {
  await assert.rejects(signOnce(() => new Promise<string>(() => undefined), 20), (e: unknown) => {
    assert.ok(e instanceof Error && !(e instanceof WalletSignError));
    assert.match((e as Error).message, /did not answer/);
    return true;
  });
  let calls = 0;
  await assert.rejects(
    addTrustlinesWithRetry(
      {
        balances: async () => fresh(),
        add: async () => {
          calls++;
          return signOnce(() => new Promise<string>(() => undefined), 20);
        },
      },
      ["USDC"],
    ),
  );
  assert.equal(calls, 1);
});

test("trustlineUi: which alert and button show", () => {
  const b = fresh();
  // Lender demo with only tBENJI missing: no alert, no button (figure only).
  assert.deepEqual(trustlineUi("demo", { ...b, usdc: 0n }, null), { gated: false, tbenjiPending: false, showInfo: false, button: null });
  // Demo missing USDC: info alert with the button.
  assert.equal(trustlineUi("demo", b, null).button?.label, "Add USDC + tBENJI trustlines");
  // Wallet missing one line: singular label.
  assert.equal(trustlineUi("wallet", { ...b, tbenji: 0n }, null).button?.label, "Add USDC trustline");
  // DW-05: any write in flight disables it (same-account sequence clash), the label stays.
  const other = trustlineUi("wallet", b, "take").button;
  assert.deepEqual(other && { label: other.label, disabled: other.disabled }, { label: "Add USDC + tBENJI trustlines", disabled: true });
  // Account not funded yet: friendbot first, no trustline button.
  assert.equal(trustlineUi("wallet", { ...b, exists: false }, null).button, null);
  // Not loaded yet.
  assert.equal(trustlineUi("wallet", null, null).button, null);
});

test("trustlineUi: per-asset banner, tSAFO-allowlisted wallet without tBENJI authorization", () => {
  const b = fresh();
  // Lender GB44-like: USDC line, no tBENJI line, on the tSAFO allowlist. Not "borrowing
  // not approved"; the tBENJI-pending note carries the same Add trustline button.
  const noLine = trustlineUi("wallet", { ...b, usdc: 0n, tsafo: 0n, tsafoAllowed: true }, null);
  assert.equal(noLine.gated, false);
  assert.equal(noLine.tbenjiPending, true);
  assert.equal(noLine.showInfo, false);
  assert.equal(noLine.button?.label, "Add tBENJI trustline");
  // tBENJI line present but unauthorized, tSAFO allowlisted: no gate, no button.
  const unauth = trustlineUi("wallet", { ...b, usdc: 0n, tbenji: 0n, tsafo: 0n, tsafoAllowed: true }, null);
  assert.deepEqual(unauth, { gated: false, tbenjiPending: true, showInfo: false, button: null });
  // Approved for neither: the access gate stays.
  const neither = trustlineUi("wallet", { ...b, usdc: 0n, tbenji: 0n }, null);
  assert.equal(neither.gated, true);
  assert.equal(neither.tbenjiPending, false);
  // tBENJI authorized: neither banner, whatever the tSAFO allowlist says.
  for (const tsafoAllowed of [false, true]) {
    const ok = trustlineUi("wallet", { ...b, usdc: 0n, tbenji: 0n, tbenjiAuthorized: true, tsafoAllowed }, null);
    assert.equal(ok.gated, false);
    assert.equal(ok.tbenjiPending, false);
  }
  // Demo keys are never gated.
  assert.equal(trustlineUi("demo", { ...b, tsafoAllowed: true }, null).tbenjiPending, false);
});
