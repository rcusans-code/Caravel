#![no_std]
//! AUTH_REQUIRED spike: can a contract hold and move a regulated classic asset via its SAC?
use soroban_sdk::{contract, contractimpl, token, Address, Env};

#[contract]
pub struct Vault;

#[contractimpl]
impl Vault {
    pub fn deposit(e: Env, from: Address, tok: Address, amt: i128) {
        from.require_auth();
        token::Client::new(&e, &tok).transfer(&from, &e.current_contract_address(), &amt);
    }

    /// Spike only: no auth on withdraw.
    pub fn withdraw(e: Env, to: Address, tok: Address, amt: i128) {
        token::Client::new(&e, &tok).transfer(&e.current_contract_address(), &to, &amt);
    }
}
