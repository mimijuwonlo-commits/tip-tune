#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    InvalidPercentage = 1,
    TotalExceeds10000 = 2,
    TrackNotFound = 3,
    InvalidAmount = 4,
    NoCollaborators = 5,
    InvalidAsset = 6,
    Overflow = 7,
    Underflow = 8,
    AlreadySettled = 9,
}

/// Represents a supported asset type
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Native,
    Token(Address),
}

/// Collaborator split configuration
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Collaborator {
    pub address: Address,
    pub percentage: u32, // Basis points (10000 = 100%)
}

/// Distribution record for a single payout
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DistributionRecord {
    pub track_id: String,
    pub payout_id: String,
    pub total_amount: i128,
    pub asset: Asset,
    pub distributions: Vec<(Address, i128)>,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    TrackSplits(String),
    DistributionLog(String, u32), // track_id, index
    LogCount(String),             // track_id -> count
    GlobalLogCount,               // total distributions
    Settled(String),              // payout_id -> bool
}

#[contract]
pub struct AutoRoyaltyDistribution;

#[contractimpl]
impl AutoRoyaltyDistribution {
    /// Set up collaborator splits for a track. Percentages are in basis points (10000 = 100%).
    pub fn set_splits(
        env: Env,
        track_id: String,
        collaborators: Vec<Collaborator>,
    ) -> Result<(), Error> {
        if collaborators.is_empty() {
            return Err(Error::NoCollaborators);
        }

        let mut total: u32 = 0;
        for collab in collaborators.iter() {
            if collab.percentage == 0 || collab.percentage > 10000 {
                return Err(Error::InvalidPercentage);
            }
            total += collab.percentage;
        }

        if total > 10000 {
            return Err(Error::TotalExceeds10000);
        }

        env.storage()
            .persistent()
            .set(&DataKey::TrackSplits(track_id.clone()), &collaborators);

        env.events()
            .publish((symbol_short!("splits"), symbol_short!("set")), track_id);

        Ok(())
    }

    /// Get split configuration for a track
    pub fn get_splits(env: Env, track_id: String) -> Result<Vec<Collaborator>, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::TrackSplits(track_id))
            .ok_or(Error::TrackNotFound)
    }

    /// Receive a tip/royalty and automatically distribute it among collaborators.
    /// Includes payout_id for duplicate prevention.
    pub fn receive_and_distribute(
        env: Env,
        track_id: String,
        payout_id: String,
        amount: i128,
        asset: Asset,
    ) -> Result<Vec<(Address, i128)>, Error> {
        // Duplicate prevention
        if env.storage().persistent().has(&DataKey::Settled(payout_id.clone())) {
            return Err(Error::AlreadySettled);
        }

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }

        let collaborators: Vec<Collaborator> = env
            .storage()
            .persistent()
            .get(&DataKey::TrackSplits(track_id.clone()))
            .ok_or(Error::TrackNotFound)?;

        let mut distributions: Vec<(Address, i128)> = Vec::new(&env);
        let mut distributed: i128 = 0;
        let count = collaborators.len();

        for i in 0..count {
            let collab = collaborators.get(i).unwrap();
            
            let share = if i == (count - 1) {
                // Last collaborator gets the remainder
                amount.checked_sub(distributed).ok_or(Error::Underflow)?
            } else {
                amount
                    .checked_mul(collab.percentage as i128)
                    .ok_or(Error::Overflow)?
                    .checked_div(10000)
                    .ok_or(Error::Overflow)?
            };

            distributions.push_back((collab.address.clone(), share));
            distributed = distributed
                .checked_add(share)
                .ok_or(Error::Overflow)?;
        }

        // Mark as settled
        env.storage().persistent().set(&DataKey::Settled(payout_id.clone()), &true);

        // Record history
        let record = DistributionRecord {
            track_id: track_id.clone(),
            payout_id: payout_id.clone(),
            total_amount: amount,
            asset: asset.clone(),
            distributions: distributions.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let log_idx: u32 = env.storage().persistent().get(&DataKey::LogCount(track_id.clone())).unwrap_or(0);
        env.storage().persistent().set(&DataKey::DistributionLog(track_id.clone(), log_idx), &record);
        env.storage().persistent().set(&DataKey::LogCount(track_id.clone()), &(log_idx + 1));

        let global_count: u64 = env.storage().instance().get(&DataKey::GlobalLogCount).unwrap_or(0);
        env.storage().instance().set(&DataKey::GlobalLogCount, &(global_count + 1));

        // Emit distribution event
        env.events()
            .publish((symbol_short!("royalty"), symbol_short!("dist"), payout_id), record);

        Ok(distributions)
    }

    /// Batch distribute royalties for multiple tracks.
    /// Returns a vector of results for each distribution attempt.
    pub fn batch_distribute(
        env: Env,
        distributions: Vec<(String, String, i128, Asset)>,
    ) -> Vec<bool> {
        let mut results = Vec::new(&env);
        for dist in distributions.iter() {
            let (track_id, payout_id, amount, asset) = dist;
            match Self::receive_and_distribute(env.clone(), track_id, payout_id, amount, asset) {
                Ok(_) => results.push_back(true),
                Err(_) => results.push_back(false),
            }
        }
        results
    }

    /// Query settlement result for a specific track and index
    pub fn get_settlement_history(env: Env, track_id: String, index: u32) -> Option<DistributionRecord> {
        env.storage().persistent().get(&DataKey::DistributionLog(track_id, index))
    }

    /// Get total settlement count for a track
    pub fn get_settlement_count(env: Env, track_id: String) -> u32 {
        env.storage().persistent().get(&DataKey::LogCount(track_id)).unwrap_or(0)
    }
}

mod test;
;
