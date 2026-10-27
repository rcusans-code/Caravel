import { Buffer } from "buffer";
import { Address } from "@stellar/stellar-sdk";
import {
  AssembledTransaction,
  Client as ContractClient,
  ClientOptions as ContractClientOptions,
  MethodOptions,
  Result,
  Spec as ContractSpec,
} from "@stellar/stellar-sdk/contract";
import type {
  u32,
  i32,
  u64,
  i64,
  u128,
  i128,
  u256,
  i256,
  Option,
  Timepoint,
  Duration,
} from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";

if (typeof window !== "undefined") {
  //@ts-ignore Buffer exists
  window.Buffer = window.Buffer || Buffer;
}


export const networks = {
  testnet: {
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CAMYOV6FMOGPJF5RDKBFYFN4J7XGOG4CDRRHUNKZ3NBAX2R6RPWRSZDN",
  }
} as const

/**
 * SEP-40 asset identifier. Same name and shape as Reflector's and as
 * `caravel_repo::Asset`, so the XDR is identical.
 */
export type Asset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};

export const Errors = {
  1: {message:"InvalidPrice"},
  2: {message:"InvalidConfig"},
  /**
   * `accept_admin` with no handover pending (Raven R6, UA-06).
   */
  3: {message:"NoPendingAdmin"},
  /**
   * `set_price` on a source-timed asset: use `set_price_at`.
   */
  4: {message:"SourceTimed"},
  /**
   * `set_price_at` on a ledger-timed asset: use `set_price`.
   */
  5: {message:"NotSourceTimed"},
  /**
   * `set_price_at` with a timestamp after the ledger time.
   */
  6: {message:"FutureTimestamp"},
  /**
   * `set_price_at` with a timestamp not after the newest record's.
   */
  7: {message:"NotNewer"},
  /**
   * `set_price_at` on the same UTC day as the newest record.
   */
  8: {message:"SameDay"},
  /**
   * `set_price_at` in the same ledger `resolution` slot as the previous
   * source-timed write.
   */
  9: {message:"TooSoon"}
}




/**
 * SEP-40 price record. `price` is scaled by `decimals()`; `timestamp` is
 * unix seconds: ledger time for a ledger-timed asset, the source's
 * publication time for a source-timed one.
 */
export interface PriceData {
  price: i128;
  timestamp: u64;
}



export interface Client {
  /**
   * Construct and simulate a base transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Asset that prices are quoted in (e.g. `Other("USD")`).
   */
  base: (options?: MethodOptions) => Promise<AssembledTransaction<Asset>>

  /**
   * Construct and simulate a admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  admin: (options?: MethodOptions) => Promise<AssembledTransaction<string>>

  /**
   * Construct and simulate a price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Price in effect at `timestamp`: the newest record with
   * `record.timestamp <= timestamp`. `None` if no record is that old.
   */
  price: ({asset, timestamp}: {asset: Asset, timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PriceData>>>

  /**
   * Construct and simulate a assets transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Every asset that has ever had a price set, in first-set order.
   */
  assets: (options?: MethodOptions) => Promise<AssembledTransaction<Array<Asset>>>

  /**
   * Construct and simulate a prices transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Up to `records` most recent prices, newest first (Reflector order).
   * `None` if the asset has no prices or `records == 0`.
   */
  prices: ({asset, records}: {asset: Asset, records: u32}, options?: MethodOptions) => Promise<AssembledTransaction<Option<Array<PriceData>>>>

  /**
   * Construct and simulate a decimals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   */
  decimals: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a lastprice transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Most recent price, or `None` if the asset was never priced.
   */
  lastprice: ({asset}: {asset: Asset}, options?: MethodOptions) => Promise<AssembledTransaction<Option<PriceData>>>

  /**
   * Construct and simulate a set_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Step 1 of 2 (Raven R6, UA-06): the current admin names `new_admin`,
   * which takes over only when it calls `accept_admin`, so a mistyped
   * address cannot lose the feed. Replaces any pending name; naming the
   * current admin cancels the handover. Emits `AdminProposed`.
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record `price` for `asset` at the current ledger time. Within the
   * newest record's `resolution` slot it replaces that record (price and
   * timestamp); in a later slot it appends a record. Older records are
   * never touched, so re-posting cannot flush the history faster than one
   * record per `resolution` seconds. `SourceTimed` if the asset is
   * source-timed.
   */
  set_price: ({asset, price}: {asset: Asset, price: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolution transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Update interval in seconds: the history keeps at most one record per
   * `resolution` slot of ledger time.
   */
  resolution: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a accept_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Step 2 of 2: the pending admin (it signs) becomes the admin. Emits
   * `AdminSet`. `NoPendingAdmin` if `set_admin` named nobody.
   */
  accept_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a set_price_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record `price` for a source-timed `asset`, stamped with `timestamp`,
   * the source's publication time (unix seconds; DECISIONS.md #39).
   * Always appends, never replaces. Errors, in this order:
   * `NotSourceTimed` (use `set_price`), `InvalidPrice` (`<= 0`),
   * `FutureTimestamp` (after the ledger time), `NotNewer` (not after the
   * newest record), `SameDay` (same UTC day as the newest record: one
   * record per NAV day), `TooSoon` (same ledger `resolution` slot as the
   * previous `set_price_at`).
   */
  set_price_at: ({asset, price, timestamp}: {asset: Asset, price: i128, timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a source_timed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * True when `asset`'s records carry the source's publication time
   * (`set_price_at`), false when they carry ledger time (`set_price`).
   */
  source_timed: ({asset}: {asset: Asset}, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>

  /**
   * Construct and simulate a pending_admin transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * The admin named by `set_admin` and not yet accepted, if any.
   */
  pending_admin: (options?: MethodOptions) => Promise<AssembledTransaction<Option<string>>>

  /**
   * Construct and simulate a set_source_timed transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Admin: make `asset` source-timed (`true`: only `set_price_at`) or
   * ledger-timed (`false`: only `set_price`, the default). Existing
   * records stay. Emits `SourceTimedSet`.
   */
  set_source_timed: ({asset, source_timed}: {asset: Asset, source_timed: boolean}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

}
export class Client extends ContractClient {
  static async deploy<T = Client>(
        /** Constructor/Initialization Args for the contract's `__constructor` method */
        {admin, base, decimals, resolution}: {admin: string, base: Asset, decimals: u32, resolution: u32},
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions &
      Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
      }
  ): Promise<AssembledTransaction<T>> {
    return ContractClient.deploy({admin, base, decimals, resolution}, options)
  }
  constructor(public readonly options: ContractClientOptions) {
    super(
      new ContractSpec([ "AAAAAgAAAHJTRVAtNDAgYXNzZXQgaWRlbnRpZmllci4gU2FtZSBuYW1lIGFuZCBzaGFwZSBhcyBSZWZsZWN0b3IncyBhbmQgYXMKYGNhcmF2ZWxfcmVwbzo6QXNzZXRgLCBzbyB0aGUgWERSIGlzIGlkZW50aWNhbC4AAAAAAAAAAAAFQXNzZXQAAAAAAAACAAAAAQAAAAAAAAAHU3RlbGxhcgAAAAABAAAAEwAAAAEAAAAAAAAABU90aGVyAAAAAAAAAQAAABE=",
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAACQAAAAAAAAAMSW52YWxpZFByaWNlAAAAAQAAAAAAAAANSW52YWxpZENvbmZpZwAAAAAAAAIAAAA6YGFjY2VwdF9hZG1pbmAgd2l0aCBubyBoYW5kb3ZlciBwZW5kaW5nIChSYXZlbiBSNiwgVUEtMDYpLgAAAAAADk5vUGVuZGluZ0FkbWluAAAAAAADAAAAOGBzZXRfcHJpY2VgIG9uIGEgc291cmNlLXRpbWVkIGFzc2V0OiB1c2UgYHNldF9wcmljZV9hdGAuAAAAC1NvdXJjZVRpbWVkAAAAAAQAAAA4YHNldF9wcmljZV9hdGAgb24gYSBsZWRnZXItdGltZWQgYXNzZXQ6IHVzZSBgc2V0X3ByaWNlYC4AAAAOTm90U291cmNlVGltZWQAAAAAAAUAAAA2YHNldF9wcmljZV9hdGAgd2l0aCBhIHRpbWVzdGFtcCBhZnRlciB0aGUgbGVkZ2VyIHRpbWUuAAAAAAAPRnV0dXJlVGltZXN0YW1wAAAAAAYAAAA+YHNldF9wcmljZV9hdGAgd2l0aCBhIHRpbWVzdGFtcCBub3QgYWZ0ZXIgdGhlIG5ld2VzdCByZWNvcmQncy4AAAAAAAhOb3ROZXdlcgAAAAcAAAA4YHNldF9wcmljZV9hdGAgb24gdGhlIHNhbWUgVVRDIGRheSBhcyB0aGUgbmV3ZXN0IHJlY29yZC4AAAAHU2FtZURheQAAAAAIAAAAV2BzZXRfcHJpY2VfYXRgIGluIHRoZSBzYW1lIGxlZGdlciBgcmVzb2x1dGlvbmAgc2xvdCBhcyB0aGUgcHJldmlvdXMKc291cmNlLXRpbWVkIHdyaXRlLgAAAAAHVG9vU29vbgAAAAAJ",
        "AAAABQAAADFUaGUgYWRtaW4gcm9sZSBtb3ZlZCB0byBgYWRtaW5gIChgYWNjZXB0X2FkbWluYCkuAAAAAAAAAAAAAAhBZG1pblNldAAAAAEAAAAJYWRtaW5fc2V0AAAAAAAAAgAAAAAAAAAFYWRtaW4AAAAAAAATAAAAAQAAAAAAAAAIcHJldmlvdXMAAAATAAAAAAAAAAI=",
        "AAAABQAAALxBIHByaWNlIHJlY29yZCB3YXMgd3JpdHRlbiAoUmF2ZW4gUjYpOiBldmVyeSBgc2V0X3ByaWNlYCBhbmQKYHNldF9wcmljZV9hdGAsIHNvIGluZGV4ZXJzIGFuZCB0aGUgcmVwbydzIG1vbml0b3JzIHNlZSBlYWNoIHB1c2gsCmluY2x1ZGluZyBpbi1zbG90IHJlcGxhY2VtZW50cy4gYHRpbWVzdGFtcGAgaXMgdGhlIHJlY29yZCdzLgAAAAAAAAAIUHJpY2VTZXQAAAABAAAACXByaWNlX3NldAAAAAAAAAMAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAEAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAAAAAAAAg==",
        "AAAAAQAAALBTRVAtNDAgcHJpY2UgcmVjb3JkLiBgcHJpY2VgIGlzIHNjYWxlZCBieSBgZGVjaW1hbHMoKWA7IGB0aW1lc3RhbXBgIGlzCnVuaXggc2Vjb25kczogbGVkZ2VyIHRpbWUgZm9yIGEgbGVkZ2VyLXRpbWVkIGFzc2V0LCB0aGUgc291cmNlJ3MKcHVibGljYXRpb24gdGltZSBmb3IgYSBzb3VyY2UtdGltZWQgb25lLgAAAAAAAAAJUHJpY2VEYXRhAAAAAAAAAgAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAG",
        "AAAABQAAAGdUaGUgY3VycmVudCBhZG1pbiBuYW1lZCBgcGVuZGluZ2AgYXMgaXRzIHN1Y2Nlc3NvciAoYHNldF9hZG1pbmApOyBpdAp0YWtlcyBvdmVyIG9ubHkgb24gYGFjY2VwdF9hZG1pbmAuAAAAAAAAAAANQWRtaW5Qcm9wb3NlZAAAAAAAAAEAAAAOYWRtaW5fcHJvcG9zZWQAAAAAAAEAAAAAAAAAB3BlbmRpbmcAAAAAEwAAAAEAAAAC",
        "AAAABQAAAEpUaGUgYWRtaW4gc3dpdGNoZWQgaG93IGBhc3NldGAncyByZWNvcmRzIGFyZSBzdGFtcGVkCihgc2V0X3NvdXJjZV90aW1lZGApLgAAAAAAAAAAAA5Tb3VyY2VUaW1lZFNldAAAAAAAAQAAABBzb3VyY2VfdGltZWRfc2V0AAAAAgAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAAAAAAAAMc291cmNlX3RpbWVkAAAAAQAAAAAAAAAC",
        "AAAAAAAAADZBc3NldCB0aGF0IHByaWNlcyBhcmUgcXVvdGVkIGluIChlLmcuIGBPdGhlcigiVVNEIilgKS4AAAAAAARiYXNlAAAAAAAAAAEAAAfQAAAABUFzc2V0AAAA",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAHhQcmljZSBpbiBlZmZlY3QgYXQgYHRpbWVzdGFtcGA6IHRoZSBuZXdlc3QgcmVjb3JkIHdpdGgKYHJlY29yZC50aW1lc3RhbXAgPD0gdGltZXN0YW1wYC4gYE5vbmVgIGlmIG5vIHJlY29yZCBpcyB0aGF0IG9sZC4AAAAFcHJpY2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAAD5FdmVyeSBhc3NldCB0aGF0IGhhcyBldmVyIGhhZCBhIHByaWNlIHNldCwgaW4gZmlyc3Qtc2V0IG9yZGVyLgAAAAAABmFzc2V0cwAAAAAAAAAAAAEAAAPqAAAH0AAAAAVBc3NldAAAAA==",
        "AAAAAAAAAHhVcCB0byBgcmVjb3Jkc2AgbW9zdCByZWNlbnQgcHJpY2VzLCBuZXdlc3QgZmlyc3QgKFJlZmxlY3RvciBvcmRlcikuCmBOb25lYCBpZiB0aGUgYXNzZXQgaGFzIG5vIHByaWNlcyBvciBgcmVjb3JkcyA9PSAwYC4AAAAGcHJpY2VzAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAAB3JlY29yZHMAAAAABAAAAAEAAAPoAAAD6gAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAAAAAAAAIZGVjaW1hbHMAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADtNb3N0IHJlY2VudCBwcmljZSwgb3IgYE5vbmVgIGlmIHRoZSBhc3NldCB3YXMgbmV2ZXIgcHJpY2VkLgAAAAAJbGFzdHByaWNlAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAA+gAAAfQAAAACVByaWNlRGF0YQAAAA==",
        "AAAAAAAAAQRTdGVwIDEgb2YgMiAoUmF2ZW4gUjYsIFVBLTA2KTogdGhlIGN1cnJlbnQgYWRtaW4gbmFtZXMgYG5ld19hZG1pbmAsCndoaWNoIHRha2VzIG92ZXIgb25seSB3aGVuIGl0IGNhbGxzIGBhY2NlcHRfYWRtaW5gLCBzbyBhIG1pc3R5cGVkCmFkZHJlc3MgY2Fubm90IGxvc2UgdGhlIGZlZWQuIFJlcGxhY2VzIGFueSBwZW5kaW5nIG5hbWU7IG5hbWluZyB0aGUKY3VycmVudCBhZG1pbiBjYW5jZWxzIHRoZSBoYW5kb3Zlci4gRW1pdHMgYEFkbWluUHJvcG9zZWRgLgAAAAlzZXRfYWRtaW4AAAAAAAABAAAAAAAAAAluZXdfYWRtaW4AAAAAAAATAAAAAA==",
        "AAAAAAAAAVxSZWNvcmQgYHByaWNlYCBmb3IgYGFzc2V0YCBhdCB0aGUgY3VycmVudCBsZWRnZXIgdGltZS4gV2l0aGluIHRoZQpuZXdlc3QgcmVjb3JkJ3MgYHJlc29sdXRpb25gIHNsb3QgaXQgcmVwbGFjZXMgdGhhdCByZWNvcmQgKHByaWNlIGFuZAp0aW1lc3RhbXApOyBpbiBhIGxhdGVyIHNsb3QgaXQgYXBwZW5kcyBhIHJlY29yZC4gT2xkZXIgcmVjb3JkcyBhcmUKbmV2ZXIgdG91Y2hlZCwgc28gcmUtcG9zdGluZyBjYW5ub3QgZmx1c2ggdGhlIGhpc3RvcnkgZmFzdGVyIHRoYW4gb25lCnJlY29yZCBwZXIgYHJlc29sdXRpb25gIHNlY29uZHMuIGBTb3VyY2VUaW1lZGAgaWYgdGhlIGFzc2V0IGlzCnNvdXJjZS10aW1lZC4AAAAJc2V0X3ByaWNlAAAAAAAAAgAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAVwcmljZQAAAAAAAAsAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAGZVcGRhdGUgaW50ZXJ2YWwgaW4gc2Vjb25kczogdGhlIGhpc3Rvcnkga2VlcHMgYXQgbW9zdCBvbmUgcmVjb3JkIHBlcgpgcmVzb2x1dGlvbmAgc2xvdCBvZiBsZWRnZXIgdGltZS4AAAAAAApyZXNvbHV0aW9uAAAAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAAHxTdGVwIDIgb2YgMjogdGhlIHBlbmRpbmcgYWRtaW4gKGl0IHNpZ25zKSBiZWNvbWVzIHRoZSBhZG1pbi4gRW1pdHMKYEFkbWluU2V0YC4gYE5vUGVuZGluZ0FkbWluYCBpZiBgc2V0X2FkbWluYCBuYW1lZCBub2JvZHkuAAAADGFjY2VwdF9hZG1pbgAAAAAAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAd5SZWNvcmQgYHByaWNlYCBmb3IgYSBzb3VyY2UtdGltZWQgYGFzc2V0YCwgc3RhbXBlZCB3aXRoIGB0aW1lc3RhbXBgLAp0aGUgc291cmNlJ3MgcHVibGljYXRpb24gdGltZSAodW5peCBzZWNvbmRzOyBERUNJU0lPTlMubWQgIzM5KS4KQWx3YXlzIGFwcGVuZHMsIG5ldmVyIHJlcGxhY2VzLiBFcnJvcnMsIGluIHRoaXMgb3JkZXI6CmBOb3RTb3VyY2VUaW1lZGAgKHVzZSBgc2V0X3ByaWNlYCksIGBJbnZhbGlkUHJpY2VgIChgPD0gMGApLApgRnV0dXJlVGltZXN0YW1wYCAoYWZ0ZXIgdGhlIGxlZGdlciB0aW1lKSwgYE5vdE5ld2VyYCAobm90IGFmdGVyIHRoZQpuZXdlc3QgcmVjb3JkKSwgYFNhbWVEYXlgIChzYW1lIFVUQyBkYXkgYXMgdGhlIG5ld2VzdCByZWNvcmQ6IG9uZQpyZWNvcmQgcGVyIE5BViBkYXkpLCBgVG9vU29vbmAgKHNhbWUgbGVkZ2VyIGByZXNvbHV0aW9uYCBzbG90IGFzIHRoZQpwcmV2aW91cyBgc2V0X3ByaWNlX2F0YCkuAAAAAAAMc2V0X3ByaWNlX2F0AAAAAwAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAAAAAAVwcmljZQAAAAAAAAsAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAABAAAD6QAAAAIAAAAD",
        "AAAAAAAAAIJUcnVlIHdoZW4gYGFzc2V0YCdzIHJlY29yZHMgY2FycnkgdGhlIHNvdXJjZSdzIHB1YmxpY2F0aW9uIHRpbWUKKGBzZXRfcHJpY2VfYXRgKSwgZmFsc2Ugd2hlbiB0aGV5IGNhcnJ5IGxlZGdlciB0aW1lIChgc2V0X3ByaWNlYCkuAAAAAAAMc291cmNlX3RpbWVkAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAAAE=",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAEYmFzZQAAB9AAAAAFQXNzZXQAAAAAAAAAAAAACGRlY2ltYWxzAAAABAAAAAAAAAAKcmVzb2x1dGlvbgAAAAAABAAAAAA=",
        "AAAAAAAAADxUaGUgYWRtaW4gbmFtZWQgYnkgYHNldF9hZG1pbmAgYW5kIG5vdCB5ZXQgYWNjZXB0ZWQsIGlmIGFueS4AAAANcGVuZGluZ19hZG1pbgAAAAAAAAAAAAABAAAD6AAAABM=",
        "AAAAAAAAAKdBZG1pbjogbWFrZSBgYXNzZXRgIHNvdXJjZS10aW1lZCAoYHRydWVgOiBvbmx5IGBzZXRfcHJpY2VfYXRgKSBvcgpsZWRnZXItdGltZWQgKGBmYWxzZWA6IG9ubHkgYHNldF9wcmljZWAsIHRoZSBkZWZhdWx0KS4gRXhpc3RpbmcKcmVjb3JkcyBzdGF5LiBFbWl0cyBgU291cmNlVGltZWRTZXRgLgAAAAAQc2V0X3NvdXJjZV90aW1lZAAAAAIAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAAAAAAMc291cmNlX3RpbWVkAAAAAQAAAAA=" ]),
      options
    )
  }
  public readonly fromJSON = {
    base: this.txFromJSON<Asset>,
        admin: this.txFromJSON<string>,
        price: this.txFromJSON<Option<PriceData>>,
        assets: this.txFromJSON<Array<Asset>>,
        prices: this.txFromJSON<Option<Array<PriceData>>>,
        decimals: this.txFromJSON<u32>,
        lastprice: this.txFromJSON<Option<PriceData>>,
        set_admin: this.txFromJSON<null>,
        set_price: this.txFromJSON<Result<void>>,
        resolution: this.txFromJSON<u32>,
        accept_admin: this.txFromJSON<Result<void>>,
        set_price_at: this.txFromJSON<Result<void>>,
        source_timed: this.txFromJSON<boolean>,
        pending_admin: this.txFromJSON<Option<string>>,
        set_source_timed: this.txFromJSON<null>
  }
}