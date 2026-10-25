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
    contractId: "CBSJ4GKNXMHRVCHTAY5TB32ESRK7LO7NXK3V66HJVLGAFTNRA5AR6257",
  }
} as const

/**
 * SEP-40 asset identifier. Same name and shape as Reflector's and as
 * `caravel_repo::Asset`, so the XDR is identical.
 */
export type Asset = {tag: "Stellar", values: readonly [string]} | {tag: "Other", values: readonly [string]};

export const Errors = {
  1: {message:"InvalidPrice"},
  2: {message:"InvalidConfig"}
}


/**
 * SEP-40 price record. `price` is scaled by `decimals()`; `timestamp` is
 * unix seconds.
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
   */
  set_admin: ({new_admin}: {new_admin: string}, options?: MethodOptions) => Promise<AssembledTransaction<null>>

  /**
   * Construct and simulate a set_price transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record `price` for `asset` at the current ledger time.
   */
  set_price: ({asset, price}: {asset: Asset, price: i128}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

  /**
   * Construct and simulate a resolution transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Nominal update interval in seconds (informational for the mock).
   */
  resolution: (options?: MethodOptions) => Promise<AssembledTransaction<u32>>

  /**
   * Construct and simulate a set_price_at transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
   * Record `price` for `asset` at an explicit `timestamp`, e.g. an old
   * one to demo a stale NAV. Kept sorted; an equal timestamp overwrites.
   */
  set_price_at: ({asset, price, timestamp}: {asset: Asset, price: i128, timestamp: u64}, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>

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
        "AAAABAAAAAAAAAAAAAAABUVycm9yAAAAAAAAAgAAAAAAAAAMSW52YWxpZFByaWNlAAAAAQAAAAAAAAANSW52YWxpZENvbmZpZwAAAAAAAAI=",
        "AAAAAQAAAFRTRVAtNDAgcHJpY2UgcmVjb3JkLiBgcHJpY2VgIGlzIHNjYWxlZCBieSBgZGVjaW1hbHMoKWA7IGB0aW1lc3RhbXBgIGlzCnVuaXggc2Vjb25kcy4AAAAAAAAACVByaWNlRGF0YQAAAAAAAAIAAAAAAAAABXByaWNlAAAAAAAACwAAAAAAAAAJdGltZXN0YW1wAAAAAAAABg==",
        "AAAAAAAAADZBc3NldCB0aGF0IHByaWNlcyBhcmUgcXVvdGVkIGluIChlLmcuIGBPdGhlcigiVVNEIilgKS4AAAAAAARiYXNlAAAAAAAAAAEAAAfQAAAABUFzc2V0AAAA",
        "AAAAAAAAAAAAAAAFYWRtaW4AAAAAAAAAAAAAAQAAABM=",
        "AAAAAAAAAHhQcmljZSBpbiBlZmZlY3QgYXQgYHRpbWVzdGFtcGA6IHRoZSBuZXdlc3QgcmVjb3JkIHdpdGgKYHJlY29yZC50aW1lc3RhbXAgPD0gdGltZXN0YW1wYC4gYE5vbmVgIGlmIG5vIHJlY29yZCBpcyB0aGF0IG9sZC4AAAAFcHJpY2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAACXRpbWVzdGFtcAAAAAAAAAYAAAABAAAD6AAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAAD5FdmVyeSBhc3NldCB0aGF0IGhhcyBldmVyIGhhZCBhIHByaWNlIHNldCwgaW4gZmlyc3Qtc2V0IG9yZGVyLgAAAAAABmFzc2V0cwAAAAAAAAAAAAEAAAPqAAAH0AAAAAVBc3NldAAAAA==",
        "AAAAAAAAAHhVcCB0byBgcmVjb3Jkc2AgbW9zdCByZWNlbnQgcHJpY2VzLCBuZXdlc3QgZmlyc3QgKFJlZmxlY3RvciBvcmRlcikuCmBOb25lYCBpZiB0aGUgYXNzZXQgaGFzIG5vIHByaWNlcyBvciBgcmVjb3JkcyA9PSAwYC4AAAAGcHJpY2VzAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAAB3JlY29yZHMAAAAABAAAAAEAAAPoAAAD6gAAB9AAAAAJUHJpY2VEYXRhAAAA",
        "AAAAAAAAAAAAAAAIZGVjaW1hbHMAAAAAAAAAAQAAAAQ=",
        "AAAAAAAAADtNb3N0IHJlY2VudCBwcmljZSwgb3IgYE5vbmVgIGlmIHRoZSBhc3NldCB3YXMgbmV2ZXIgcHJpY2VkLgAAAAAJbGFzdHByaWNlAAAAAAAAAQAAAAAAAAAFYXNzZXQAAAAAAAfQAAAABUFzc2V0AAAAAAAAAQAAA+gAAAfQAAAACVByaWNlRGF0YQAAAA==",
        "AAAAAAAAAAAAAAAJc2V0X2FkbWluAAAAAAAAAQAAAAAAAAAJbmV3X2FkbWluAAAAAAAAEwAAAAA=",
        "AAAAAAAAADZSZWNvcmQgYHByaWNlYCBmb3IgYGFzc2V0YCBhdCB0aGUgY3VycmVudCBsZWRnZXIgdGltZS4AAAAAAAlzZXRfcHJpY2UAAAAAAAACAAAAAAAAAAVhc3NldAAAAAAAB9AAAAAFQXNzZXQAAAAAAAAAAAAABXByaWNlAAAAAAAACwAAAAEAAAPpAAAAAgAAAAM=",
        "AAAAAAAAAEBOb21pbmFsIHVwZGF0ZSBpbnRlcnZhbCBpbiBzZWNvbmRzIChpbmZvcm1hdGlvbmFsIGZvciB0aGUgbW9jaykuAAAACnJlc29sdXRpb24AAAAAAAAAAAABAAAABA==",
        "AAAAAAAAAIdSZWNvcmQgYHByaWNlYCBmb3IgYGFzc2V0YCBhdCBhbiBleHBsaWNpdCBgdGltZXN0YW1wYCwgZS5nLiBhbiBvbGQKb25lIHRvIGRlbW8gYSBzdGFsZSBOQVYuIEtlcHQgc29ydGVkOyBhbiBlcXVhbCB0aW1lc3RhbXAgb3ZlcndyaXRlcy4AAAAADHNldF9wcmljZV9hdAAAAAMAAAAAAAAABWFzc2V0AAAAAAAH0AAAAAVBc3NldAAAAAAAAAAAAAAFcHJpY2UAAAAAAAALAAAAAAAAAAl0aW1lc3RhbXAAAAAAAAAGAAAAAQAAA+kAAAACAAAAAw==",
        "AAAAAAAAAAAAAAANX19jb25zdHJ1Y3RvcgAAAAAAAAQAAAAAAAAABWFkbWluAAAAAAAAEwAAAAAAAAAEYmFzZQAAB9AAAAAFQXNzZXQAAAAAAAAAAAAACGRlY2ltYWxzAAAABAAAAAAAAAAKcmVzb2x1dGlvbgAAAAAABAAAAAA=" ]),
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
        set_price_at: this.txFromJSON<Result<void>>
  }
}