#![no_std]

//! Testnet stand-in for a Spiko fund token (tSAFO), modelled on
//! `spiko-tech/stellar-contracts` `contracts/token` (DECISIONS.md #28).
//!
//! What it keeps from the real token, because Caravel depends on it:
//! - a custom Soroban token, not a SAC: no trustlines, no `AUTH_REQUIRED`;
//! - an allowlist checked on **every** transfer, for both `from` and `to`
//!   (Spiko: `PermissionManager.has_role(account, WLISTED)`), and on mint;
//! - **no `approve` / `allowance` / `transfer_from` / `burn_from`**: a
//!   contract can only move tokens the holder signed for in the same call;
//! - `from.require_auth()` inside `transfer` (OpenZeppelin `Base::transfer`);
//! - an issuer pause that blocks transfers and mints;
//! - 5 decimals by default (eurSAFO mainnet `decimals()` = 5), set in the
//!   constructor like Spiko's.
//!
//! What it simplifies: the allowlist lives in the token instead of a
//! separate permission-manager contract, one admin holds every role
//! (minter, pauser, whitelister), and failures are typed errors (codes from
//! 100, so they never decode as a Caravel `Error`) where Spiko panics with
//! `"Invalid role"`. Both revert the whole transaction the same way.

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, Address, Env, String,
};

#[cfg(test)]
mod test;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SpikoError {
    /// `from` or `to` is not on the allowlist (Spiko: "Invalid role").
    NotWhitelisted = 100,
    /// The issuer paused the token.
    Paused = 101,
    /// Zero or negative amount (Spiko: "Invalid zero-amount transfer").
    InvalidAmount = 102,
    InsufficientBalance = 103,
}

#[contracttype]
enum Key {
    Admin,
    Paused,
    Decimals,
    Name,
    Symbol,
    Supply,
    Balance(Address),
    Whitelisted(Address),
}

#[contractevent(topics = ["transfer"], data_format = "single-value")]
pub struct Transfer {
    #[topic]
    pub from: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["mint"], data_format = "single-value")]
pub struct Mint {
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contractevent(topics = ["whitelist"], data_format = "single-value")]
pub struct Whitelisted {
    #[topic]
    pub account: Address,
    pub allowed: bool,
}

#[contractevent(topics = ["paused"], data_format = "single-value")]
pub struct PausedSet {
    pub paused: bool,
}

const DAY_LEDGERS: u32 = 17_280;
// Same TTL policy as contracts/repo/src/storage.rs: a 6-day instance bump
// stays inside a fresh deploy's code TTL, so testnet charges no code rent.
const INSTANCE_BUMP: u32 = 6 * DAY_LEDGERS;
const INSTANCE_THRESHOLD: u32 = INSTANCE_BUMP - DAY_LEDGERS;
const BUMP_LEDGERS: u32 = 30 * DAY_LEDGERS;
const THRESHOLD_LEDGERS: u32 = BUMP_LEDGERS - DAY_LEDGERS;

#[contract]
pub struct SpikoMock;

#[contractimpl]
impl SpikoMock {
    pub fn __constructor(env: Env, admin: Address, name: String, symbol: String, decimals: u32) {
        let s = env.storage().instance();
        s.set(&Key::Admin, &admin);
        s.set(&Key::Paused, &false);
        s.set(&Key::Decimals, &decimals);
        s.set(&Key::Name, &name);
        s.set(&Key::Symbol, &symbol);
        s.set(&Key::Supply, &0i128);
        extend_instance(&env);
    }

    // --- SEP-41 subset (the part Spiko implements) ---------------------------

    /// Moves `amount` from `from` to `to`. Both must be allowlisted, the token
    /// unpaused, `amount > 0`, and `from` must authorize.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) -> Result<(), SpikoError> {
        require_not_paused(&env)?;
        require_whitelisted(&env, &from)?;
        require_whitelisted(&env, &to)?;
        if amount <= 0 {
            return Err(SpikoError::InvalidAmount);
        }
        from.require_auth();
        let from_balance = read_balance(&env, &from);
        if from_balance < amount {
            return Err(SpikoError::InsufficientBalance);
        }
        write_balance(&env, &from, from_balance - amount);
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        extend_instance(&env);
        Transfer { from, to, amount }.publish(&env);
        Ok(())
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        read_balance(&env, &id)
    }

    pub fn total_supply(env: Env) -> i128 {
        env.storage().instance().get(&Key::Supply).unwrap_or(0)
    }

    pub fn decimals(env: Env) -> u32 {
        env.storage().instance().get(&Key::Decimals).unwrap()
    }

    pub fn name(env: Env) -> String {
        env.storage().instance().get(&Key::Name).unwrap()
    }

    pub fn symbol(env: Env) -> String {
        env.storage().instance().get(&Key::Symbol).unwrap()
    }

    // --- issuer (one admin holds Spiko's MINTER / PAUSER / WHITELISTER) -------

    pub fn admin(env: Env) -> Address {
        read_admin(&env)
    }

    /// Mints to an allowlisted account (Spiko: `mint`, MINTER role).
    pub fn mint(env: Env, to: Address, amount: i128) -> Result<(), SpikoError> {
        read_admin(&env).require_auth();
        require_not_paused(&env)?;
        require_whitelisted(&env, &to)?;
        if amount <= 0 {
            return Err(SpikoError::InvalidAmount);
        }
        write_balance(&env, &to, read_balance(&env, &to) + amount);
        let supply = Self::total_supply(env.clone()) + amount;
        env.storage().instance().set(&Key::Supply, &supply);
        extend_instance(&env);
        Mint { to, amount }.publish(&env);
        Ok(())
    }

    /// Adds or removes an allowlisted holder (Spiko: permission manager
    /// `grant_role` / `revoke_role` with `WLISTED`).
    pub fn set_whitelisted(env: Env, account: Address, allowed: bool) {
        read_admin(&env).require_auth();
        let key = Key::Whitelisted(account.clone());
        if allowed {
            env.storage().persistent().set(&key, &true);
            env.storage()
                .persistent()
                .extend_ttl(&key, THRESHOLD_LEDGERS, BUMP_LEDGERS);
        } else {
            env.storage().persistent().remove(&key);
        }
        extend_instance(&env);
        Whitelisted { account, allowed }.publish(&env);
    }

    pub fn is_whitelisted(env: Env, account: Address) -> bool {
        is_whitelisted(&env, &account)
    }

    pub fn pause(env: Env) {
        set_paused(&env, true);
    }

    pub fn unpause(env: Env) {
        set_paused(&env, false);
    }

    pub fn paused(env: Env) -> bool {
        env.storage().instance().get(&Key::Paused).unwrap_or(false)
    }
}

fn extend_instance(env: &Env) {
    env.storage()
        .instance()
        .extend_ttl(INSTANCE_THRESHOLD, INSTANCE_BUMP);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&Key::Admin).unwrap()
}

fn set_paused(env: &Env, paused: bool) {
    read_admin(env).require_auth();
    env.storage().instance().set(&Key::Paused, &paused);
    extend_instance(env);
    PausedSet { paused }.publish(env);
}

fn require_not_paused(env: &Env) -> Result<(), SpikoError> {
    if env.storage().instance().get(&Key::Paused).unwrap_or(false) {
        return Err(SpikoError::Paused);
    }
    Ok(())
}

fn is_whitelisted(env: &Env, account: &Address) -> bool {
    env.storage()
        .persistent()
        .has(&Key::Whitelisted(account.clone()))
}

fn require_whitelisted(env: &Env, account: &Address) -> Result<(), SpikoError> {
    if !is_whitelisted(env, account) {
        return Err(SpikoError::NotWhitelisted);
    }
    Ok(())
}

fn read_balance(env: &Env, id: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&Key::Balance(id.clone()))
        .unwrap_or(0)
}

fn write_balance(env: &Env, id: &Address, amount: i128) {
    let key = Key::Balance(id.clone());
    env.storage().persistent().set(&key, &amount);
    env.storage()
        .persistent()
        .extend_ttl(&key, THRESHOLD_LEDGERS, BUMP_LEDGERS);
}
