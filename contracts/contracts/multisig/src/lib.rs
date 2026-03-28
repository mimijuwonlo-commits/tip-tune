#![no_std]

mod test;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, token, Address, Env, String,
    Vec,
};

// ─── Constants ────────────────────────────────────────────────────────────────

/// Timeout in ledgers before a pending tip can be cancelled (~24 hours).
const TIMEOUT_LEDGERS: u32 = 17_280;

/// Maximum number of required signatures allowed.
const MAX_REQUIRED_SIGS: u32 = 10;

/// Minimum amount (in base units) that requires multi-sig (not yet enforced).
#[allow(dead_code)]
const MULTISIG_THRESHOLD: i128 = 10_000_000_000; // 1000 tokens

// ─── Storage Keys ─────────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    /// Admin address
    Admin,
    /// Token contract address
    Token,
    /// TipProposal by tip_id
    Tip(String),
    /// Nonce for generating unique tip IDs
    Nonce,
    /// Approved signers whitelist (Vec<Address>)
    Signers,
    /// Per-actor nonce for replay protection
    ActorNonce(Address),
}

// ─── Data Structures ──────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub enum TipStatus {
    /// Collecting signatures.
    Pending,
    /// Threshold met and tip executed.
    Executed,
    /// Cancelled by tipper or timed out.
    Cancelled,
}

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct TipActionEvent {
    pub action: String,
    pub tip_id: String,
    pub tipper: Address,
    pub artist: Address,
    pub amount: i128,
    pub required_sigs: Option<u32>,
    pub approvals: Option<u32>,
    pub operator: Address,
    pub status: String,
    pub expires_at: Option<u64>,
    pub timestamp: u64,
}

impl TipActionEvent {
    fn new(
        env: &Env,
        action: &str,
        tip_id: String,
        tipper: Address,
        artist: Address,
        amount: i128,
        required_sigs: Option<u32>,
        approvals: Option<u32>,
        operator: Address,
        status: &str,
        expires_at: Option<u64>,
    ) -> TipActionEvent {
        TipActionEvent {
            action: String::from_str(env, action),
            tip_id,
            tipper,
            artist,
            amount,
            required_sigs,
            approvals,
            operator,
            status: String::from_str(env, status),
            expires_at,
            timestamp: env.ledger().timestamp(),
        }
    }
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct TipProposal {
    /// Unique tip identifier.
    pub tip_id: String,
    /// Address initiating the tip.
    pub tipper: Address,
    /// Artist receiving the tip.
    pub artist: Address,
    /// Amount to tip in base units.
    pub amount: i128,
    /// Number of signatures required to execute.
    pub required_sigs: u32,
    /// Addresses that have approved so far.
    pub approvals: Vec<Address>,
    /// Current status.
    pub status: TipStatus,
    /// Ledger timestamp at which this tip expires.
    pub expires_at: u64,
    /// Ledger this proposal was created.
    pub created_at: u32,
}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// Caller is not authorised.
    Unauthorized = 1,
    /// Contract not initialised.
    NotInitialised = 2,
    /// Already initialised.
    AlreadyInitialised = 3,
    /// Tip proposal not found.
    TipNotFound = 4,
    /// Tip is not in pending state.
    TipNotPending = 5,
    /// Approver has already signed.
    AlreadyApproved = 6,
    /// Required sigs exceeds maximum.
    TooManySigners = 7,
    /// Required sigs is zero.
    ZeroSigners = 8,
    /// Tip has expired.
    TipExpired = 9,
    /// Tip has not expired yet (for timeout cancellation).
    TipNotExpired = 10,
    /// Amount is zero or negative.
    InvalidAmount = 11,
    /// Approver is not a whitelisted signer.
    NotWhitelisted = 12,
    /// Signer already in whitelist.
    AlreadyWhitelisted = 13,
    /// Overflow in arithmetic.
    Overflow = 14,
    /// Only tipper can cancel before timeout.
    OnlyTipperCanCancel = 15,
    /// Invalid nonce for replay protection.
    InvalidNonce = 16,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct MultisigContract;

#[contractimpl]
impl MultisigContract {
    // ── Initialisation ───────────────────────────────────────────────────────

    /// Initialise the contract with an admin and token address.
    pub fn initialize(env: Env, admin: Address, token: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::AlreadyInitialised);
        }
        admin.require_auth();
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::Token, &token);
        env.storage().instance().set(&DataKey::Nonce, &0_u64);
        // Admin is the first whitelisted signer by default.
        let signers: Vec<Address> = Vec::from_array(&env, [admin.clone()]);
        env.storage().instance().set(&DataKey::Signers, &signers);
        Ok(())
    }

    // ── Signer Management ────────────────────────────────────────────────────

    /// Add a whitelisted signer (admin only).
    pub fn add_signer(env: Env, signer: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let mut signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        // Check not already whitelisted.
        for i in 0..signers.len() {
            if signers.get(i).unwrap() == signer {
                return Err(Error::AlreadyWhitelisted);
            }
        }
        signers.push_back(signer.clone());
        env.storage().instance().set(&DataKey::Signers, &signers);
        env.events()
            .publish((symbol_short!("addSigner"), signer), ());
        Ok(())
    }

    /// Remove a whitelisted signer (admin only).
    pub fn remove_signer(env: Env, signer: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env));

        let mut new_signers: Vec<Address> = Vec::new(&env);
        for i in 0..signers.len() {
            let s = signers.get(i).unwrap();
            if s != signer {
                new_signers.push_back(s);
            }
        }
        env.storage()
            .instance()
            .set(&DataKey::Signers, &new_signers);
        env.events()
            .publish((symbol_short!("rmSigner"), signer), ());
        Ok(())
    }

    /// Get all whitelisted signers.
    pub fn get_signers(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(&env))
    }

    // ── Multi-sig Tip Creation ────────────────────────────────────────────────

    /// Create a multi-sig tip proposal.
    ///
    /// Locks `amount` tokens from `tipper` into the contract.
    /// Returns the unique `tip_id` for this proposal.
    pub fn create_multisig_tip(
        env: Env,
        tipper: Address,
        artist: Address,
        amount: i128,
        required_sigs: u32,
        nonce: u64,
    ) -> Result<String, Error> {
        tipper.require_auth();
        Self::assert_initialised(&env)?;

        // Replay protection: check and update actor nonce
        let last_nonce: u64 = env.storage().instance().get(&DataKey::ActorNonce(tipper.clone())).unwrap_or(0);
        if nonce <= last_nonce {
            return Err(Error::InvalidNonce);
        }
        env.storage().instance().set(&DataKey::ActorNonce(tipper.clone()), &nonce);

        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if required_sigs == 0 {
            return Err(Error::ZeroSigners);
        }
        if required_sigs > MAX_REQUIRED_SIGS {
            return Err(Error::TooManySigners);
        }

        // Lock tokens from tipper into contract.
        let token = Self::get_token(&env);
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&tipper, &env.current_contract_address(), &amount);

        // Generate unique tip ID from nonce + ledger.
        let nonce: u64 = env.storage().instance().get(&DataKey::Nonce).unwrap_or(0);
        let tip_id = Self::generate_tip_id(&env, nonce);
        env.storage().instance().set(&DataKey::Nonce, &(nonce + 1));

        const SECONDS_PER_LEDGER: u64 = 5;
        let timeout_seconds = (TIMEOUT_LEDGERS as u64)
            .checked_mul(SECONDS_PER_LEDGER)
            .ok_or(Error::Overflow)?;
        let expires_at = env
            .ledger()
            .timestamp()
            .checked_add(timeout_seconds)
            .ok_or(Error::Overflow)?;

        let proposal = TipProposal {
            tip_id: tip_id.clone(),
            tipper: tipper.clone(),
            artist: artist.clone(),
            amount,
            required_sigs,
            approvals: Vec::new(&env),
            status: TipStatus::Pending,
            expires_at,
            created_at: env.ledger().sequence(),
        };

        env.storage()
            .persistent()
            .set(&DataKey::Tip(tip_id.clone()), &proposal);

        env.events().publish(
            (symbol_short!("TIP"), symbol_short!("CREATE")),
            TipActionEvent::new(
                &env,
                "CREATE",
                tip_id.clone(),
                tipper.clone(),
                artist.clone(),
                amount,
                Some(required_sigs),
                Some(0),
                tipper.clone(),
                "PENDING",
                Some(expires_at),
            ),
        );

        Ok(tip_id)
    }

    // ── Approval ─────────────────────────────────────────────────────────────

    /// Approve a pending tip proposal.
    ///
    /// Returns `true` if this approval triggered execution (threshold met).
    /// Returns `false` if more signatures are still needed.
    pub fn approve_tip(env: Env, tip_id: String, approver: Address, nonce: u64) -> Result<bool, Error> {
        approver.require_auth();
        Self::assert_initialised(&env)?;

        // Replay protection: check and update actor nonce
        let last_nonce: u64 = env.storage().instance().get(&DataKey::ActorNonce(approver.clone())).unwrap_or(0);
        if nonce <= last_nonce {
            return Err(Error::InvalidNonce);
        }
        env.storage().instance().set(&DataKey::ActorNonce(approver.clone()), &nonce);

        // Verify approver is whitelisted.
        Self::assert_whitelisted(&env, &approver)?;

        let mut proposal: TipProposal = env
            .storage()
            .persistent()
            .get(&DataKey::Tip(tip_id.clone()))
            .ok_or(Error::TipNotFound)?;

        // State checks.
        if proposal.status != TipStatus::Pending {
            return Err(Error::TipNotPending);
        }

        if env.ledger().timestamp() > proposal.expires_at {
            return Err(Error::TipExpired);
        }

        // Duplicate signature check.
        for i in 0..proposal.approvals.len() {
            if proposal.approvals.get(i).unwrap() == approver {
                return Err(Error::AlreadyApproved);
            }
        }

        // Record approval.
        proposal.approvals.push_back(approver.clone());

        // Recalculate valid approvals (only those still whitelisted)
        let valid_count = Self::count_valid_approvals(&env, &proposal.approvals);

        env.events().publish(
            (symbol_short!("TIP"), symbol_short!("APPROVE")),
            TipActionEvent::new(
                &env,
                "APPROVE",
                tip_id.clone(),
                proposal.tipper.clone(),
                proposal.artist.clone(),
                proposal.amount,
                Some(proposal.required_sigs),
                Some(valid_count),
                approver.clone(),
                "PENDING",
                Some(proposal.expires_at),
            ),
        );

        // Check if threshold is met using ONLY valid approvals.
        if valid_count >= proposal.required_sigs {
            // Execute the tip — transfer to artist.
            let token = Self::get_token(&env);
            let token_client = token::Client::new(&env, &token);
            token_client.transfer(
                &env.current_contract_address(),
                &proposal.artist,
                &proposal.amount,
            );

            proposal.status = TipStatus::Executed;
            env.storage()
                .persistent()
                .set(&DataKey::Tip(tip_id.clone()), &proposal);

            env.events().publish(
                (symbol_short!("TIP"), symbol_short!("EXECUTE")),
                TipActionEvent::new(
                    &env,
                    "EXECUTE",
                    tip_id,
                    proposal.tipper.clone(),
                    proposal.artist.clone(),
                    proposal.amount,
                    Some(proposal.required_sigs),
                    Some(valid_count),
                    approver.clone(),
                    "EXECUTED",
                    Some(proposal.expires_at),
                ),
            );

            return Ok(true);
        }

        // Save updated proposal with new approval.
        env.storage()
            .persistent()
            .set(&DataKey::Tip(tip_id), &proposal);
        Ok(false)
    }

    /// Get number of valid approvals currently on a tip.
    pub fn get_valid_approvals_count(env: Env, tip_id: String) -> u32 {
        if let Some(p) = env.storage().persistent().get::<DataKey, TipProposal>(&DataKey::Tip(tip_id)) {
            Self::count_valid_approvals(&env, &p.approvals)
        } else {
            0
        }
    }

    /// Check if an address is a whitelisted signer.
    pub fn is_signer(env: Env, signer: Address) -> bool {
        Self::assert_whitelisted(&env, &signer).is_ok()
    }

    // ── Internal Helpers ─────────────────────────────────────────────────────

    fn count_valid_approvals(env: &Env, approvals: &Vec<Address>) -> u32 {
        let signers: Vec<Address> = env.storage().instance().get(&DataKey::Signers).unwrap_or_else(|| Vec::new(env));
        let mut count = 0;
        for i in 0..approvals.len() {
            let app = approvals.get(i).unwrap();
            for j in 0..signers.len() {
                if signers.get(j).unwrap() == app {
                    count += 1;
                    break;
                }
            }
        }
        count
    }

    // ── Cancellation ─────────────────────────────────────────────────────────

    /// Cancel a pending tip.
    ///
    /// - Tipper can cancel at any time before execution.
    /// - Anyone can cancel after the timeout has elapsed.
    /// Refunds locked tokens to the tipper.
    pub fn cancel_tip(env: Env, tip_id: String, caller: Address, nonce: u64) -> Result<(), Error> {
        caller.require_auth();

        // Replay protection: check and update actor nonce
        let last_nonce: u64 = env.storage().instance().get(&DataKey::ActorNonce(caller.clone())).unwrap_or(0);
        if nonce <= last_nonce {
            return Err(Error::InvalidNonce);
        }
        env.storage().instance().set(&DataKey::ActorNonce(caller.clone()), &nonce);

        let mut proposal: TipProposal = env
            .storage()
            .persistent()
            .get(&DataKey::Tip(tip_id.clone()))
            .ok_or(Error::TipNotFound)?;

        if proposal.status != TipStatus::Pending {
            return Err(Error::TipNotPending);
        }

        let is_tipper = caller == proposal.tipper;
        let is_expired = env.ledger().timestamp() > proposal.expires_at;

        // Only tipper can cancel before timeout; anyone can cancel after.
        if !is_tipper && !is_expired {
            return Err(Error::TipNotExpired);
        }

        // Refund tokens to tipper.
        let token = Self::get_token(&env);
        let token_client = token::Client::new(&env, &token);
        token_client.transfer(
            &env.current_contract_address(),
            &proposal.tipper,
            &proposal.amount,
        );

        proposal.status = TipStatus::Cancelled;
        env.storage()
            .persistent()
            .set(&DataKey::Tip(tip_id.clone()), &proposal);

        env.events().publish(
            (symbol_short!("TIP"), symbol_short!("CANCEL")),
            TipActionEvent::new(
                &env,
                "CANCEL",
                tip_id.clone(),
                proposal.tipper.clone(),
                proposal.artist.clone(),
                proposal.amount,
                Some(proposal.required_sigs),
                Some(proposal.approvals.len()),
                caller.clone(),
                "CANCELLED",
                Some(proposal.expires_at),
            ),
        );

        Ok(())
    }

    // ── View Functions ───────────────────────────────────────────────────────

    /// Get all pending approvals (addresses that have signed) for a tip.
    pub fn get_pending_approvals(env: Env, tip_id: String) -> Vec<Address> {
        match env
            .storage()
            .persistent()
            .get::<DataKey, TipProposal>(&DataKey::Tip(tip_id))
        {
            None => Vec::new(&env),
            Some(p) => p.approvals,
        }
    }

    /// Get the full proposal details for a tip.
    pub fn get_tip(env: Env, tip_id: String) -> Option<TipProposal> {
        env.storage().persistent().get(&DataKey::Tip(tip_id))
    }

    /// Get number of approvals still needed for a tip.
    pub fn approvals_needed(env: Env, tip_id: String) -> u32 {
        match env
            .storage()
            .persistent()
            .get::<DataKey, TipProposal>(&DataKey::Tip(tip_id))
        {
            None => 0,
            Some(p) => {
                if p.approvals.len() >= p.required_sigs {
                    0
                } else {
                    p.required_sigs - p.approvals.len()
                }
            }
        }
    }

    /// Check if a tip has expired.
    pub fn is_expired(env: Env, tip_id: String) -> bool {
        match env
            .storage()
            .persistent()
            .get::<DataKey, TipProposal>(&DataKey::Tip(tip_id))
        {
            None => false,
            Some(p) => env.ledger().timestamp() > p.expires_at,
        }
    }

    // ── Admin ────────────────────────────────────────────────────────────────

    /// Transfer admin rights.
    pub fn transfer_admin(env: Env, new_admin: Address) -> Result<(), Error> {
        Self::require_admin(&env)?;
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        Ok(())
    }

    /// Update the tip timeout (admin only).
    pub fn get_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::Admin)
    }

    // ── Internal Helpers ─────────────────────────────────────────────────────

    fn assert_initialised(env: &Env) -> Result<(), Error> {
        if !env.storage().instance().has(&DataKey::Admin) {
            return Err(Error::NotInitialised);
        }
        Ok(())
    }

    fn require_admin(env: &Env) -> Result<Address, Error> {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .ok_or(Error::NotInitialised)?;
        admin.require_auth();
        Ok(admin)
    }

    fn get_token(env: &Env) -> Address {
        env.storage().instance().get(&DataKey::Token).unwrap()
    }

    fn assert_whitelisted(env: &Env, signer: &Address) -> Result<(), Error> {
        let signers: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::Signers)
            .unwrap_or_else(|| Vec::new(env));

        for i in 0..signers.len() {
            if &signers.get(i).unwrap() == signer {
                return Ok(());
            }
        }
        Err(Error::NotWhitelisted)
    }

    /// Generate a unique tip ID string from nonce and ledger sequence.
    /// Format: "tip-{ledger}-{nonce}"
    fn generate_tip_id(env: &Env, nonce: u64) -> String {
        // Build a simple deterministic ID.
        // In production consider using env.crypto().sha256() for a hash-based ID.
        let ledger = env.ledger().sequence() as u64;
        // Encode as base-10 digits in a fixed-length Soroban String.
        let id_num: u64 = ledger
            .wrapping_mul(1_000_000)
            .wrapping_add(nonce % 1_000_000);
        Self::u64_to_string(env, id_num)
    }

    /// Convert a u64 to a Soroban String (no std, no format!).
    fn u64_to_string(env: &Env, mut n: u64) -> String {
        let mut buf = [0u8; 20];
        let mut pos = 20usize;
        if n == 0 {
            pos -= 1;
            buf[pos] = b'0';
        } else {
            while n > 0 {
                pos -= 1;
                buf[pos] = b'0' + (n % 10) as u8;
                n /= 10;
            }
        }
        // Prefix with "t" to make it a valid identifier.
        let digits = &buf[pos..];
        let mut full = [b't'; 21];
        full[1..1 + digits.len()].copy_from_slice(digits);
        String::from_bytes(env, &full[..1 + digits.len()])
    }
}
