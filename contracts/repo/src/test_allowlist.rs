//! Compliance-agnostic proof (DECISIONS.md #24).
//!
//! `AllowlistToken` is a test-only SEP-41 token that enforces its own holder
//! allowlist inside `transfer`, the way a Soroban-native fund token (e.g.
//! Spiko) does compliance in its contract instead of with classic
//! AUTH_REQUIRED trustlines (BENJI, our tBENJI SAC). It is not a SAC.
//!
//! The repo contract moves collateral only through `token::Client` (SEP-41),
//! so it works unchanged with either model: the issuer, not Caravel, decides
//! who may hold the collateral, including the repo contract itself.

extern crate std;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    testutils::{Address as _, Ledger as _},
    token::{StellarAssetClient, TokenClient, TokenInterface},
    Address, Env, InvokeError, MuxedAddress, String,
};

use crate::{
    oracle::mock::{setup_mock_oracle, MockOracleClient, ONE},
    test::{
        demo_config, APR_BPS, DEMO_NAV_AGE, NOW, NO_CAP, PRINCIPAL, TERM_SECS, UNIT, WIDE_BAND_BPS,
    },
    Asset, AssetConfig, CaravelRepo, CaravelRepoClient, Status,
};

// --- the token ------------------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum TokenError {
    // Codes clear of the repo's own `Error` range, so a failed take shows
    // which contract refused it.
    NotAllowlisted = 101,
    InsufficientBalance = 102,
    NegativeAmount = 103,
    /// Allowances and burns are out of scope for the proof.
    Unsupported = 104,
}

#[contracttype]
enum Key {
    Issuer,
    Allowed(Address),
    Balance(Address),
}

#[contract]
pub struct AllowlistToken;

fn issuer(env: &Env) -> Address {
    env.storage().instance().get(&Key::Issuer).unwrap()
}

fn is_allowed(env: &Env, holder: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&Key::Allowed(holder.clone()))
        .unwrap_or(false)
}

fn require_allowed(env: &Env, holder: &Address) {
    if !is_allowed(env, holder) {
        panic_with_error!(env, TokenError::NotAllowlisted);
    }
}

fn read_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&Key::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    env.storage()
        .persistent()
        .set(&Key::Balance(id.clone()), &amount);
}

#[contractimpl]
impl AllowlistToken {
    pub fn __constructor(env: Env, issuer: Address) {
        env.storage().instance().set(&Key::Issuer, &issuer);
    }

    /// Issuer-only: add or remove a permitted holder (KYC'd wallet or
    /// approved contract).
    pub fn allow(env: Env, holder: Address, allowed: bool) {
        issuer(&env).require_auth();
        env.storage()
            .persistent()
            .set(&Key::Allowed(holder), &allowed);
    }

    pub fn allowed(env: Env, holder: Address) -> bool {
        is_allowed(&env, &holder)
    }

    /// Issuer-only; the recipient must be allowlisted.
    pub fn mint(env: Env, to: Address, amount: i128) {
        issuer(&env).require_auth();
        if amount < 0 {
            panic_with_error!(&env, TokenError::NegativeAmount);
        }
        require_allowed(&env, &to);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
    }
}

#[contractimpl(contracttrait)]
impl TokenInterface for AllowlistToken {
    fn allowance(_env: Env, _from: Address, _spender: Address) -> i128 {
        0
    }

    fn approve(env: Env, _from: Address, _spender: Address, _amount: i128, _live_until: u32) {
        panic_with_error!(&env, TokenError::Unsupported);
    }

    fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    /// The compliance check: both sides must be on the issuer's allowlist.
    fn transfer(env: Env, from: Address, to: MuxedAddress, amount: i128) {
        from.require_auth();
        if amount < 0 {
            panic_with_error!(&env, TokenError::NegativeAmount);
        }
        let to = to.address();
        require_allowed(&env, &from);
        require_allowed(&env, &to);
        let have = read_balance(&env, &from);
        if have < amount {
            panic_with_error!(&env, TokenError::InsufficientBalance);
        }
        write_balance(&env, &from, have - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
    }

    fn transfer_from(env: Env, _spender: Address, _from: Address, _to: Address, _amount: i128) {
        panic_with_error!(&env, TokenError::Unsupported);
    }

    fn burn(env: Env, _from: Address, _amount: i128) {
        panic_with_error!(&env, TokenError::Unsupported);
    }

    fn burn_from(env: Env, _spender: Address, _from: Address, _amount: i128) {
        panic_with_error!(&env, TokenError::Unsupported);
    }

    fn decimals(_env: Env) -> u32 {
        7
    }

    fn name(env: Env) -> String {
        String::from_str(&env, "Allowlisted Fund Share")
    }

    fn symbol(env: Env) -> String {
        String::from_str(&env, "tFUND")
    }
}

// --- the proof ------------------------------------------------------------------

struct Fund<'a> {
    repo: CaravelRepoClient<'a>,
    usdc: TokenClient<'a>,
    fund: AllowlistTokenClient<'a>,
    fund_token: TokenClient<'a>,
    lender: Address,
    borrower: Address,
}

/// A repo contract with USDC (a SAC) and `tFUND` (an allowlist token, not a
/// SAC) as collateral. The issuer has allowlisted only the borrower so far.
fn fund_world<'a>() -> Fund<'a> {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set_timestamp(NOW);

    let usdc = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    let issuer = Address::generate(&env);
    let fund_id = env.register(AllowlistToken, (issuer,));
    let fund = AllowlistTokenClient::new(&env, &fund_id);

    let oracle = MockOracleClient::new(&env, &setup_mock_oracle(&env));
    oracle.set_price(&Asset::Stellar(fund_id.clone()), &ONE, &NOW);

    let mut config = demo_config(&env);
    config.usdc = usdc.clone();
    config.oracle = oracle.address.clone();
    let repo = CaravelRepoClient::new(&env, &env.register(CaravelRepo, (config,)));
    repo.set_asset(
        &fund_id,
        &AssetConfig {
            oracle_asset: Asset::Stellar(fund_id.clone()),
            haircut_bps: 300,
            enabled: true,
            max_nav_age_secs: DEMO_NAV_AGE,
            max_nav_move_bps: WIDE_BAND_BPS,
            nav_floor: None,
            nav_ceiling: None,
            max_open_debt: NO_CAP,
        },
    );

    let lender = Address::generate(&env);
    let borrower = Address::generate(&env);
    StellarAssetClient::new(&env, &usdc).mint(&lender, &(10_000 * UNIT));
    StellarAssetClient::new(&env, &usdc).mint(&borrower, &(100 * UNIT));
    fund.allow(&borrower, &true);
    fund.mint(&borrower, &(2_000 * UNIT));

    Fund {
        usdc: TokenClient::new(&env, &usdc),
        fund_token: TokenClient::new(&env, &fund_id),
        fund,
        repo,
        lender,
        borrower,
    }
}

impl Fund<'_> {
    fn offer(&self) -> u64 {
        self.repo.create_offer(
            &self.lender,
            &self.fund.address,
            &PRINCIPAL,
            &APR_BPS,
            &TERM_SECS,
        )
    }
}

#[test]
fn allowlist_token_take_and_repay_when_repo_is_allowlisted() {
    let f = fund_world();
    // The issuer approves the repo contract as a holder, just as a BENJI
    // issuer would `set_authorized` it on the classic trustline.
    f.fund.allow(&f.repo.address, &true);

    let repo_id = f.repo.take_offer(&f.borrower, &f.offer(), &false);
    let repo = f.repo.repo(&repo_id);
    assert_eq!(repo.status, Status::Open);
    assert_eq!(
        f.fund_token.balance(&f.repo.address),
        repo.collateral_amount
    );
    assert_eq!(
        f.fund_token.balance(&f.borrower),
        2_000 * UNIT - repo.collateral_amount
    );
    assert_eq!(f.usdc.balance(&f.borrower), 100 * UNIT + PRINCIPAL);

    f.repo.repay(&repo_id);
    assert_eq!(f.repo.repo(&repo_id).status, Status::Repaid);
    assert_eq!(f.fund_token.balance(&f.borrower), 2_000 * UNIT);
    assert_eq!(f.fund_token.balance(&f.repo.address), 0);
    assert_eq!(f.usdc.balance(&f.repo.address), 0);
    assert!(f.usdc.balance(&f.lender) > 10_000 * UNIT);
}

#[test]
fn allowlist_token_blocks_take_when_repo_is_not_allowlisted() {
    let f = fund_world();
    let offer_id = f.offer();

    // Same flow, but the issuer never approved the repo contract: the token's
    // own transfer rejects the collateral leg, and the DvP reverts whole.
    assert_eq!(
        f.repo.try_take_offer(&f.borrower, &offer_id, &false),
        Err(Err(InvokeError::Contract(
            TokenError::NotAllowlisted as u32
        )))
    );
    assert_eq!(f.fund_token.balance(&f.borrower), 2_000 * UNIT);
    assert_eq!(f.fund_token.balance(&f.repo.address), 0);
    assert_eq!(f.usdc.balance(&f.repo.address), PRINCIPAL);
    assert_eq!(f.usdc.balance(&f.borrower), 100 * UNIT);
    assert_eq!(f.repo.offer(&offer_id).id, offer_id);

    // Once the issuer allowlists it, the same offer goes through.
    f.fund.allow(&f.repo.address, &true);
    assert!(f
        .repo
        .try_take_offer(&f.borrower, &offer_id, &false)
        .is_ok());
}
