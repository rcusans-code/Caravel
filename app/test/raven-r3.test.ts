// Raven R3 (app unhappy path): every failure keeps its tx hash and a mapped reason,
// contract writes time out like the trustline, no double submits, restored sessions
// are network-checked, reads time out, a frozen USDC line is shown.
// One test (or more) per finding id. Run: npm test (plain node --test, no bundler).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Socket } from "node:net";
import { StrKey, contract, rpc, xdr } from "@stellar/stellar-sdk";
import {
  PENDING_TEXT,
  TxError,
  errorEvents,
  friendbotAlreadyFunded,
  resultCodes,
  sendAssembled,
  sendClassic,
  txHashOf,
  txText,
  type AssembledLike,
} from "../src/txerror.ts";
import { WRITE_SIGN_TIMEOUT_TEXT, WalletSignError, boundedSign } from "../src/trustline.ts";
import { WrongNetworkError, onOtherNetwork, restoreWallet } from "../src/session.ts";
import { bounded, fetchWithin } from "../src/net.ts";
import { USDC_FROZEN, usdcBlock } from "../src/gates.ts";

// explain()'s wallet-decline check (app/src/errors.ts), which used to swallow every trustline submit error.
const DECLINE = /declin|reject|denied|cancel+ed|user closed|not allowed/i;
const HASH = "ab".repeat(32);
const REPO = "CD4Q2QTOIRJOUPKK46N5MZMTRQXZVOO6N5FRXHK3BEBBPDSXQNQMK6YN";
const TESTNET = "Test SDF Network ; September 2015";

const txResult = (result: xdr.TransactionResultResult) =>
  new xdr.TransactionResult({ feeCharged: xdr.Int64.fromString("100"), result, ext: new xdr.TransactionResultExt(0) });
const failedOps = (...ops: xdr.OperationResult[]) => txResult(xdr.TransactionResultResult.txFailed(ops));
const lowReserve = () =>
  failedOps(xdr.OperationResult.opInner(xdr.OperationResultTr.changeTrust(xdr.ChangeTrustResult.changeTrustLowReserve())));
const trapped = () =>
  failedOps(
    xdr.OperationResult.opInner(
      xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()),
    ),
  );
const errorEvent = (contractId: string, err: xdr.ScError) =>
  new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: StrKey.decodeContract(contractId) as never,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({ topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(err)], data: xdr.ScVal.scvVoid() }),
      ),
    }),
  });

/** The SDK's own SendFailed text (sent_transaction.js: JSON of the sendTransaction response). */
const sendFailed = (code: string) =>
  new contract.SentTransaction.Errors.SendFailed(
    `Sending the transaction to the network failed!\n${JSON.stringify(
      { status: "ERROR", hash: HASH, errorResult: txResult((xdr.TransactionResultResult as unknown as Record<string, () => xdr.TransactionResultResult>)[code]()) },
      null,
      2,
    )}`,
  );

/** A fake AssembledTransaction: signs, then `send` plays one network outcome. */
function assembled<R>(send: AssembledLike<R>["send"]): AssembledLike<R> & { signs: number } {
  const t = {
    signs: 0,
    signed: undefined as undefined | { hash(): Uint8Array },
    async sign() {
      t.signs++;
      t.signed = { hash: () => Buffer.from(HASH, "hex") };
    },
    send,
  };
  return t;
}

const rejectsTx = async (p: Promise<unknown>, check: (e: TxError) => void) =>
  assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof TxError, `TxError expected, got ${String(e)}`);
    check(e);
    return true;
  });

// --- DW-01: trustline submit errors ------------------------------------------------------

test("DW-01 trustline submit ERROR keeps its code and hash and is never read as a wallet decline", async () => {
  for (const [code, want] of [
    ["txInsufficientBalance", /Not enough XLM to pay the network fee/],
    ["txBadSeq", /Another transaction from this account went first/],
    ["txTooLate", /expired before it reached the network/],
  ] as const) {
    const server = {
      sendTransaction: async () => ({
        status: "ERROR",
        hash: HASH,
        errorResult: txResult((xdr.TransactionResultResult as unknown as Record<string, () => xdr.TransactionResultResult>)[code]()),
      }),
      pollTransaction: async () => assert.fail("an ERROR tx is not polled"),
    };
    await rejectsTx(sendClassic(server, { hash: () => Buffer.from(HASH, "hex") }), (e) => {
      assert.equal(e.message, `Trustline tx not accepted: ${code}`);
      assert.doesNotMatch(e.message, DECLINE, "wording no longer trips explain()'s decline regex");
      assert.equal(e.hash, HASH);
      assert.equal(e.stage, "rejected");
      assert.match(txText(e)!, want);
    });
  }
  // The old wording, should it reach explain() from anywhere, maps by code too (code check runs first).
  assert.match(txText(new Error("Trustline tx rejected: txBadSeq"))!, /went first/);
});

test("DW-01 a FAILED changeTrust decodes the low-reserve op code and passes the hash through", async () => {
  const submitted: string[] = [];
  const server = {
    sendTransaction: async () => ({ status: "PENDING", hash: HASH }),
    pollTransaction: async () => ({ status: "FAILED", txHash: HASH, resultXdr: lowReserve() }),
  };
  await rejectsTx(sendClassic(server, { hash: () => Buffer.from(HASH, "hex") }, "Trustline tx", (h) => submitted.push(h)), (e) => {
    assert.equal(e.stage, "failed");
    assert.equal(e.code, "changeTrustLowReserve");
    assert.equal(e.hash, HASH);
    assert.match(e.message, /^Trustline tx failed on-chain \(txFailed, changeTrustLowReserve\)/);
    assert.match(txText(e)!, /0\.5 XLM/);
  });
  assert.deepEqual(submitted, [HASH], "hash shown at submit, before the result");
});

// --- DW-02: Soroban writes ---------------------------------------------------------------

test("DW-02 SendFailed txTooLate / txBadSeq / txInsufficientBalance: mapped text plus the hash", async () => {
  for (const [code, want] of [
    ["txTooLate", /expired before it reached the network/],
    ["txBadSeq", /went first/],
    ["txInsufficientBalance", /Not enough XLM/],
  ] as const) {
    const tx = assembled(async () => {
      throw sendFailed(code);
    });
    await rejectsTx(sendAssembled(tx), (e) => {
      assert.equal(e.stage, "rejected");
      assert.equal(e.code, code);
      assert.equal(e.hash, HASH, "the hash of the signed envelope");
      assert.match(txText(e)!, want);
    });
  }
});

test("DW-02 meta-v4 FAILED: the status is checked before .result (no TypeError), contract error kept", async () => {
  const submitted: string[] = [];
  const tx = assembled(async (watcher) => {
    watcher?.onSubmitted?.({ hash: HASH });
    return {
      getTransactionResponse: {
        status: "FAILED",
        txHash: HASH,
        resultXdr: trapped(),
        diagnosticEventsXdr: [errorEvent(REPO, xdr.ScError.sceContract(10))],
      },
      // What the generated Client does with returnValue === undefined.
      get result(): never {
        throw new TypeError("Cannot read properties of undefined (reading 'switch')");
      },
    };
  });
  await rejectsTx(sendAssembled(tx, (h) => submitted.push(h)), (e) => {
    assert.equal(e.stage, "failed");
    assert.equal(e.hash, HASH);
    assert.equal(e.code, "invokeHostFunctionTrapped");
    // explain() parses this log line into "The collateral does not cover the debt…" (repo error #10).
    assert.match(e.message, new RegExp(`contract:${REPO}, topics:\\[error, Error\\(Contract, #10\\)\\]`));
    assert.equal(txText(e), null, "contract errors are left to explain()'s contract map");
  });
  assert.deepEqual(submitted, [HASH], "onSubmitted fired with the hash before the result");
});

test("DW-02 FAILED with a host error (no contract code) maps to the resource-budget text", () => {
  const e = errorEvents([errorEvent(REPO, xdr.ScError.sceStorage(xdr.ScErrorCode.scecExceededLimit()))]);
  assert.deepEqual(e, [`contract:${REPO}, topics:[error, Error(Storage, ExceededLimit)]`]);
  assert.match(txText(new TxError(`Transaction failed on-chain (txFailed, invokeHostFunctionTrapped)\n${e[0]}`, { hash: HASH, stage: "failed" }))!, /resource budget/);
  assert.deepEqual(resultCodes(trapped()), ["txFailed", "invokeHostFunctionTrapped"]);
});

test("DW-02 still pending (poll timeout) or RPC drop after send: 'check the hash before retrying'", async () => {
  for (const err of [
    new contract.SentTransaction.Errors.TransactionStillPending("Waited 300 seconds for transaction to complete, but it did not."),
    new Error("timeout of 15000ms exceeded"),
  ]) {
    const tx = assembled(async () => {
      throw err;
    });
    await rejectsTx(sendAssembled(tx), (e) => {
      assert.equal(e.stage, "pending");
      assert.equal(e.hash, HASH);
      assert.equal(txText(e), PENDING_TEXT);
    });
  }
  // getTransaction answered NOT_FOUND to the end: same.
  const nf = assembled(async () => ({ getTransactionResponse: { status: "NOT_FOUND" }, result: undefined }));
  await rejectsTx(sendAssembled(nf), (e) => assert.equal(txText(e), PENDING_TEXT));
});

test("DW-02 success returns the confirmed hash and value; a wallet decline throws before any hash", async () => {
  const ok = assembled(async () => ({ getTransactionResponse: { status: "SUCCESS", txHash: HASH }, result: 7n }));
  assert.deepEqual(await sendAssembled(ok), { hash: HASH, value: 7n });
  const declined: AssembledLike<null> = {
    sign: async () => {
      throw new WalletSignError({ code: -4, message: "User declined access" });
    },
    send: async () => assert.fail("nothing is sent after a decline"),
  };
  await assert.rejects(sendAssembled(declined), (e: unknown) => e instanceof WalletSignError && txHashOf(e) === null);
});

// --- DW-04: contract writes time out like the trustline ----------------------------------

test("DW-04 a contract write whose wallet never answers fails after the limit with a generic message", async () => {
  const phases: string[] = [];
  const sign = boundedSign(() => new Promise<{ signedTxXdr: string }>(() => undefined), (p) => phases.push(p), 20);
  await assert.rejects(sign(), (e: unknown) => e instanceof Error && e.message === WRITE_SIGN_TIMEOUT_TEXT);
  assert.deepEqual(phases, ["sign"], "never reaches submit");
  assert.doesNotMatch(WRITE_SIGN_TIMEOUT_TEXT, /trustline/i);

  const phases2: string[] = [];
  const ok = boundedSign(async (x: string) => ({ signedTxXdr: `signed:${x}` }), (p) => phases2.push(p), 1000);
  assert.deepEqual(await ok("xdr"), { signedTxXdr: "signed:xdr" });
  assert.deepEqual(phases2, ["sign", "submit"]);
});

// --- DW-05: friendbot double click --------------------------------------------------------

test("DW-05 friendbot 400 createAccountAlreadyExist counts as funded; other failures do not", () => {
  // Body shape of the live second click (dapp-wallet-evidence/repro-output.txt).
  const body = JSON.stringify({
    type: "https://stellar.org/horizon-errors/transaction_failed",
    status: 400,
    detail: "createAccountAlreadyExist (AAAAAAAAAGT/////AAAAAQAAAAAAAAAA/////AAAAAA=)",
  });
  assert.equal(friendbotAlreadyFunded(400, body), true);
  assert.equal(friendbotAlreadyFunded(400, '{"detail":"op_already_exists"}'), true);
  assert.equal(friendbotAlreadyFunded(500, body), false);
  assert.equal(friendbotAlreadyFunded(400, '{"detail":"rate limited"}'), false);
});

// --- DW-06: restored session network check ------------------------------------------------

function fakeKit(net: () => Promise<{ networkPassphrase?: string } | undefined>) {
  const k = { disconnects: 0, getAddress: async () => ({ address: "GABC" }), getNetwork: net, disconnect: async () => void k.disconnects++ };
  return k;
}

test("DW-06 restore on another network disconnects and throws WrongNetworkError", async () => {
  const k = fakeKit(async () => ({ networkPassphrase: "Public Global Stellar Network ; September 2015" }));
  await assert.rejects(restoreWallet(k, TESTNET), (e: unknown) => e instanceof WrongNetworkError && /disconnected/.test(e.message));
  assert.equal(k.disconnects, 1, "kit cleared, so the next reload does not restore it");
});

test("DW-06 restore on testnet, or a wallet that cannot report its network, keeps the session", async () => {
  const same = fakeKit(async () => ({ networkPassphrase: TESTNET }));
  assert.equal(await restoreWallet(same, TESTNET), "GABC");
  const silent = fakeKit(async () => {
    throw new Error("not supported");
  });
  assert.equal(await restoreWallet(silent, TESTNET), "GABC");
  assert.equal(same.disconnects + silent.disconnects, 0);
  assert.equal(await onOtherNetwork(async () => undefined, TESTNET), false);
});

// --- Q-01: reads time out ----------------------------------------------------------------

test("Q-01 a hung RPC or Horizon fails the read within its timeout", async () => {
  const sockets: Socket[] = [];
  const hung = createServer((s) => void sockets.push(s)); // accepts, never answers
  await new Promise<void>((r) => hung.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(hung.address() as { port: number }).port}`;
  try {
    const server = bounded(new rpc.Server(url, { allowHttp: true }), 300);
    let t = Date.now();
    await assert.rejects(server.getHealth(), /timeout/i);
    assert.ok(Date.now() - t < 3000, `RPC gave up after ${Date.now() - t} ms`);
    t = Date.now();
    await assert.rejects(fetchWithin(`${url}/accounts/GABC`, 300), (e: unknown) => (e as Error).name === "TimeoutError");
    assert.ok(Date.now() - t < 3000, `Horizon gave up after ${Date.now() - t} ms`);
  } finally {
    sockets.forEach((s) => s.destroy());
    hung.close();
  }
});

// --- AS-04: frozen USDC line --------------------------------------------------------------

test("AS-04 a frozen USDC line blocks lend/take/repay/claim with its own text", () => {
  const b = { exists: true, xlm: 1n, usdc: 5n, usdcAuthorized: false, tbenji: null, tbenjiAuthorized: false, tsafo: null, tsafoAllowed: false };
  assert.equal(usdcBlock(b, "USDC"), USDC_FROZEN);
  assert.match(USDC_FROZEN, /USDC frozen by its issuer/);
  assert.equal(usdcBlock({ ...b, usdcAuthorized: true }, "USDC"), null);
  assert.equal(usdcBlock({ ...b, usdc: null }, "USDC"), null, "no line: the trustline prompt covers it");
  assert.equal(usdcBlock({ ...b, exists: false }, "USDC"), null);
  assert.equal(usdcBlock(null, "USDC"), null);
});
