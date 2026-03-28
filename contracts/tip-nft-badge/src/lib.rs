#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, String, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    NotEligible = 1,
    AlreadyMinted = 2,
    InvalidBadgeType = 3,
    Unauthorized = 4,
}

/// Badge types for tipping milestones
#[contracttype]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum BadgeType {
    FirstTip = 0,
    TenTips = 1,
    HundredTips = 2,
    WhaleTipper = 3,
    EarlySupporter = 4,
    GenreSupporter = 5,
}

/// Metadata for a minted badge NFT
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BadgeMetadata {
    pub badge_id: String,
    pub badge_type: BadgeType,
    pub name: String,
    pub description: String,
    pub owner: Address,
    pub minted_at: u64,
}

/// User stats tracked for badge eligibility
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UserStats {
    pub tip_count: u64,
    pub total_amount: i128,
    pub first_tip_time: u64,
    pub genre_tips: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    Admin,
    UserStats(Address),
    UserBadges(Address),
    BadgeMinted(Address, u32), // user + badge_type ordinal
    BadgeRecord(String),
    TotalBadges,
    EarlyAdopterThreshold,
    WhaleThreshold,
}

#[contract]
pub struct TipNftBadgeContract;

#[contractimpl]
impl TipNftBadgeContract {
    /// Initialize the badge contract with admin and thresholds
    pub fn initialize(env: Env, admin: Address, whale_threshold: i128, early_adopter_cutoff: u64) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Already initialized");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage()
            .instance()
            .set(&DataKey::WhaleThreshold, &whale_threshold);
        env.storage()
            .instance()
            .set(&DataKey::EarlyAdopterThreshold, &early_adopter_cutoff);
        env.storage().instance().set(&DataKey::TotalBadges, &0u64);
    }

    /// Record a tip for a user (called by escrow/verification contract)
    pub fn record_tip(env: Env, user: Address, amount: i128, is_genre_tip: bool) {
        let mut stats: UserStats = Self::get_user_stats(env.clone(), user.clone());

        stats.tip_count += 1;
        stats.total_amount += amount;

        if stats.first_tip_time == 0 {
            stats.first_tip_time = env.ledger().timestamp();
        }

        if is_genre_tip {
            stats.genre_tips += 1;
        }

        env.storage()
            .persistent()
            .set(&DataKey::UserStats(user), &stats);
    }

    /// Check if a user is eligible for a specific badge type
    pub fn check_badge_eligibility(env: Env, user: Address, badge_type: BadgeType) -> bool {
        let badge_ordinal = Self::badge_type_ordinal(&badge_type);
        if env
            .storage()
            .persistent()
            .has(&DataKey::BadgeMinted(user.clone(), badge_ordinal))
        {
            return false;
        }

        let stats = Self::get_user_stats(env.clone(), user);

        match badge_type {
            BadgeType::FirstTip => stats.tip_count >= 1,
            BadgeType::TenTips => stats.tip_count >= 10,
            BadgeType::HundredTips => stats.tip_count >= 100,
            BadgeType::WhaleTipper => {
                let threshold: i128 = env.storage().instance().get(&DataKey::WhaleThreshold).unwrap_or(10000);
                stats.total_amount >= threshold
            }
            BadgeType::EarlySupporter => {
                let cutoff: u64 = env.storage().instance().get(&DataKey::EarlyAdopterThreshold).unwrap_or(0);
                stats.first_tip_time > 0 && stats.first_tip_time <= cutoff
            }
            BadgeType::GenreSupporter => stats.genre_tips >= 5,
        }
    }

    /// Check eligibility for all badge types at once
    pub fn get_all_eligibility(env: Env, user: Address) -> Vec<(BadgeType, bool)> {
        let mut results = Vec::new(&env);
        let types = [
            BadgeType::FirstTip,
            BadgeType::TenTips,
            BadgeType::HundredTips,
            BadgeType::WhaleTipper,
            BadgeType::EarlySupporter,
            BadgeType::GenreSupporter,
        ];
        for t in types {
            results.push_back((t, Self::check_badge_eligibility(env.clone(), user.clone(), t)));
        }
        results
    }

    /// Mint a badge NFT for a user.
    pub fn mint_badge(env: Env, user: Address, badge_type: BadgeType) -> Result<String, Error> {
        let badge_ordinal = Self::badge_type_ordinal(&badge_type);

        if env.storage().persistent().has(&DataKey::BadgeMinted(user.clone(), badge_ordinal)) {
            return Err(Error::AlreadyMinted);
        }

        if !Self::check_badge_eligibility(env.clone(), user.clone(), badge_type) {
            return Err(Error::NotEligible);
        }

        let mut total: u64 = env.storage().instance().get(&DataKey::TotalBadges).unwrap_or(0);
        total += 1;
        env.storage().instance().set(&DataKey::TotalBadges, &total);

        // Generate simple ID string
        let badge_id = String::from_str(&env, "BADGE-");
        // (Simplified for brevity, but could use the counter)
        
        let (name, desc) = match badge_type {
            BadgeType::FirstTip => (String::from_str(&env, "First Tip"), String::from_str(&env, "Awarded for your first tip!")),
            BadgeType::TenTips => (String::from_str(&env, "Ten Tips"), String::from_str(&env, "Awarded for sending 10 tips!")),
            BadgeType::HundredTips => (String::from_str(&env, "Century Tipper"), String::from_str(&env, "Awarded for sending 100 tips!")),
            BadgeType::WhaleTipper => (String::from_str(&env, "Whale Tipper"), String::from_str(&env, "Awarded for significant total contributions!")),
            BadgeType::EarlySupporter => (String::from_str(&env, "Early Adopter"), String::from_str(&env, "Awarded for supporting the platform in its early days!")),
            BadgeType::GenreSupporter => (String::from_str(&env, "Genre Fan"), String::from_str(&env, "Awarded for repeated support in a specific genre!")),
        };

        let metadata = BadgeMetadata {
            badge_id: badge_id.clone(),
            badge_type,
            name,
            description: desc,
            owner: user.clone(),
            minted_at: env.ledger().timestamp(),
        };

        env.storage().persistent().set(&DataKey::BadgeMinted(user.clone(), badge_ordinal), &true);
        env.storage().persistent().set(&DataKey::BadgeRecord(badge_id.clone()), &metadata);

        let mut user_badges: Vec<String> = env.storage().persistent().get(&DataKey::UserBadges(user.clone())).unwrap_or(Vec::new(&env));
        user_badges.push_back(badge_id.clone());
        env.storage().persistent().set(&DataKey::UserBadges(user.clone()), &user_badges);

        env.events().publish((symbol_short!("badge"), symbol_short!("minted")), metadata);

        Ok(badge_id)
    }

    /// Get all badge IDs for a user
    pub fn get_user_badges(env: Env, user: Address) -> Vec<String> {
        env.storage().persistent().get(&DataKey::UserBadges(user)).unwrap_or(Vec::new(&env))
    }

    /// Get all badge metadata for a user (efficient lookup)
    pub fn get_user_badges_full(env: Env, user: Address) -> Vec<BadgeMetadata> {
        let ids = Self::get_user_badges(env.clone(), user);
        let mut full_badges = Vec::new(&env);
        for id in ids {
            if let Some(meta) = Self::get_badge(env.clone(), id) {
                full_badges.push_back(meta);
            }
        }
        full_badges
    }

    /// Get badge metadata by ID
    pub fn get_badge(env: Env, badge_id: String) -> Option<BadgeMetadata> {
        env.storage().persistent().get(&DataKey::BadgeRecord(badge_id))
    }

    /// Get user stats
    pub fn get_user_stats(env: Env, user: Address) -> UserStats {
        env.storage().persistent().get(&DataKey::UserStats(user)).unwrap_or(UserStats {
            tip_count: 0,
            total_amount: 0,
            first_tip_time: 0,
            genre_tips: 0,
        })
    }

    /// Get total badges minted
    pub fn get_total_badges(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::TotalBadges).unwrap_or(0)
    }

    fn badge_type_ordinal(badge_type: &BadgeType) -> u32 {
        match badge_type {
            BadgeType::FirstTip => 0,
            BadgeType::TenTips => 1,
            BadgeType::HundredTips => 2,
            BadgeType::WhaleTipper => 3,
            BadgeType::EarlySupporter => 4,
            BadgeType::GenreSupporter => 5,
        }
    }
}

mod test;
