use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotImplemented = 1,
    InvalidConfig = 2,
    InvalidAmount = 3,
    MathOverflow = 4,
    OfferNotFound = 5,
    RepoNotFound = 6,
    InvalidStatus = 7,
    WrongAsset = 8,
    StaleNav = 9,
    InsufficientCollateral = 10,
    NotLiquidator = 11,
    NotDefaultable = 12,
}
