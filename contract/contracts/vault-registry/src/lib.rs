#![no_std]
//! MindVault on-chain vault registry.
//!
//! Records each vault resource on Stellar: its creator, price (in USDC
//! stroops, 7 decimals), and a metadata pointer (e.g. an IPFS URI or content
//! hash). Payment itself still flows through x402 + the USDC SAC off this
//! contract — this registry is the transparent, on-chain source of truth for
//! *what* exists, *who* owns it, and *what it costs*.
//!
//! Only the recorded creator can mutate a resource (enforced via
//! `require_auth`). Ownership can be transferred.

extern crate alloc;

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, symbol_short, Address, Env, IntoVal,
    String, Val, Vec,
};

// ~5s ledgers → 17,280 per day. Persistent entries are bumped ~30 days on each
// write so an actively-managed resource is never archived out from under us.
const DAY_IN_LEDGERS: u32 = 17280;
const BUMP_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
const LIFETIME_THRESHOLD: u32 = BUMP_AMOUNT - DAY_IN_LEDGERS;
/// Max length for metadata pointers (IPFS URI, content hash, compact JSON anchor).
pub const MAX_METADATA_POINTER_LEN: u32 = 512;
pub const MAX_TERMS_HASH_LEN: u32 = 64;
const MAX_TAGS: u32 = 8;
const MAX_TAG_LEN: u32 = 32;

#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct Resource {
    pub id: String,
    pub creator: Address,
    pub price: i128,
    pub metadata: String,
    pub listed: bool,
    /// Discovery labels (e.g. "dataset", "research"). Distinct from `metadata`,
    /// which remains the off-chain content anchor (IPFS URI, content hash, etc.).
    pub tags: Vec<String>,
}

/// One page of the on-chain catalog plus a cursor for the next page.
///
/// `next_cursor` is the catalog index to pass back into `list` / `list_page`
/// as `start`/`cursor`. `None` means end-of-list — clients must not recompute
/// offsets themselves.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogPage {
    pub items: Vec<Resource>,
    pub next_cursor: Option<u32>,
}

#[contracttype]
pub enum DataKey {
    Resource(String),
    Count,
    Index(u32),
    CreatorTerms(Address),
}

/// Event data emitted when a resource's metadata pointer is updated.
/// Carries the resource id, the previous metadata pointer, and the new one
/// so that off-chain indexers can build a full audit trail without querying
/// historical ledger state.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct MetadataUpdateEvent {
    pub id: String,
    pub old_metadata: String,
    pub new_metadata: String,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    AlreadyRegistered = 1,
    NotFound = 2,
    InvalidPrice = 3,
    MetadataTooLong = 4,
    InvalidTag = 5,
    TermsHashTooLong = 6,
}

#[contract]
pub struct VaultRegistry;

#[contractimpl]
impl VaultRegistry {
    /// Register a new resource. Errors if `id` already exists or `price <= 0`.
    /// Requires the creator's authorization.
    pub fn register(
        env: Env,
        creator: Address,
        id: String,
        price: i128,
        metadata: String,
        tags: Vec<String>,
    ) -> Result<(), Error> {
        creator.require_auth();
        if price <= 0 {
            return Err(Error::InvalidPrice);
        }
        Self::validate_resource_id(&id)?;
        Self::validate_metadata_pointer(&metadata)?;
        Self::validate_tags(&env, &tags)?;
        if Self::is_reserved_id(&id) {
            return Err(Error::ReservedId);
        }
        let key = DataKey::Resource(id.clone());
        if env.storage().persistent().has(&key) {
            return Err(Error::AlreadyRegistered);
        }

        let resource = Resource {
            id: id.clone(),
            creator: creator.clone(),
            price,
            metadata,
            listed: true,
            tags,
        };
        env.storage().persistent().set(&key, &resource);
        Self::bump_persistent(&env, &key);

        let count: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let idx_key = DataKey::Index(count);
        env.storage().persistent().set(&idx_key, &id);
        Self::bump_persistent(&env, &idx_key);
        env.storage().instance().set(&DataKey::Count, &(count + 1));
        Self::bump_instance(&env);

        let mut list = Self::creator_list(&env, &creator);
        list.push_back(id.clone());
        env.storage()
            .persistent()
            .set(&Self::creator_key(&env, &creator), &list);
        Self::bump_persistent(&env, &Self::creator_key(&env, &creator));

        let cur = Self::creator_count(&env, &creator);
        Self::set_creator_count(&env, &creator, cur + 1);

        env.events()
            .publish((symbol_short!("register"), creator), id);
        Ok(())
    }

    /// Update a resource's price. Only the creator may call this.
    pub fn set_price(env: Env, id: String, new_price: i128) -> Result<(), Error> {
        Self::validate_resource_id(&id)?;
        if new_price <= 0 {
            return Err(Error::InvalidPrice);
        }
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        resource.price = new_price;
        Self::save(&env, &resource);
        env.events()
            .publish((symbol_short!("setprice"), id), new_price);
        Ok(())
    }

    /// Update a resource's metadata pointer. Only the creator may call this.
    ///
    /// Emits a [`MetadataUpdateEvent`] containing the resource id, the previous
    /// metadata pointer (`old_metadata`), and the new one (`new_metadata`).
    /// Off-chain indexers can use these fields to build an audit trail without
    /// querying historical ledger state.
    pub fn update_metadata(env: Env, id: String, metadata: String) -> Result<(), Error> {
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        Self::validate_metadata_pointer(&metadata)?;
        let old_metadata = resource.metadata.clone();
        resource.metadata = metadata.clone();
        Self::save(&env, &resource);
        env.events().publish(
            (symbol_short!("updmeta"), id.clone()),
            MetadataUpdateEvent {
                id,
                old_metadata,
                new_metadata: metadata,
            },
        );
        Ok(())
    }

    /// Replace a resource's discovery tags. Only the creator may call this.
    /// Does not modify `metadata` (the off-chain content pointer).
    pub fn set_tags(env: Env, id: String, tags: Vec<String>) -> Result<(), Error> {
        Self::validate_resource_id(&id)?;
        Self::validate_tags(&env, &tags)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        resource.tags = tags.clone();
        Self::save(&env, &resource);
        env.events().publish((symbol_short!("settags"), id), tags);
        Ok(())
    }

    pub fn transfer_ownership(env: Env, id: String, new_creator: Address) -> Result<(), Error> {
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        if resource.creator == new_creator {
            return Err(Error::AlreadyOwner);
        }
        resource.creator = new_creator.clone();
        Self::save(&env, &resource);
        
        let pending_key = DataKey::PendingTransfer(id.clone());
        if env.storage().persistent().has(&pending_key) {
            env.storage().persistent().remove(&pending_key);
        }

        env.events()
            .publish((symbol_short!("transfer"), id), new_creator);
        Ok(())
    }

    /// Propose a transfer to a new owner. The new owner must accept it.
    pub fn propose_transfer(env: Env, id: String, new_creator: Address) -> Result<(), Error> {
        let resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        if resource.creator == new_creator {
            return Err(Error::AlreadyOwner);
        }
        let key = DataKey::PendingTransfer(id.clone());
        env.storage().persistent().set(&key, &new_creator);
        Self::bump_persistent(&env, &key);
        env.events().publish((symbol_short!("propose"), id), new_creator);
        Ok(())
    }

    /// Accept a proposed transfer. Only the pending owner can call this.
    pub fn accept_transfer(env: Env, id: String) -> Result<(), Error> {
        let key = DataKey::PendingTransfer(id.clone());
        let pending_owner: Address = env.storage().persistent().get(&key).ok_or(Error::NoPendingTransfer)?;
        pending_owner.require_auth();
        
        let mut resource = Self::load(&env, &id)?;
        resource.creator = pending_owner.clone();
        Self::save(&env, &resource);
        
        env.storage().persistent().remove(&key);
        
        env.events().publish((symbol_short!("transfer"), id), pending_owner);
        Ok(())
    }

    /// Cancel a proposed transfer. Only the current owner can call this.
    pub fn cancel_transfer(env: Env, id: String) -> Result<(), Error> {
        let resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        
        let key = DataKey::PendingTransfer(id.clone());
        if !env.storage().persistent().has(&key) {
            return Err(Error::NoPendingTransfer);
        }
        env.storage().persistent().remove(&key);
        env.events().publish((symbol_short!("cancel"), id), ());
        Ok(())
    }

    /// Set the listing state of a resource. Only the creator may call this.
    pub fn set_listed(env: Env, id: String, listed: bool) -> Result<(), Error> {
        Self::validate_resource_id(&id)?;
        let mut resource = Self::load(&env, &id)?;
        resource.creator.require_auth();
        resource.listed = listed;
        Self::save(&env, &resource);
        env.events()
            .publish((symbol_short!("setlisted"), id), listed);
        Ok(())
    }

    /// Delist a resource (convenience method for set_listed(false)). Only the creator may call this.
    pub fn delist(env: Env, id: String) -> Result<(), Error> {
        Self::set_listed(env, id, false)
    }

    /// Paginated resource list in insertion order. `limit` is capped at 20.
    ///
    /// Kept for callers that only need the page body. Prefer `list_page` when
    /// the client must know the next cursor / end-of-list without recomputing
    /// offsets.
    pub fn list(env: Env, start: u32, limit: u32) -> Vec<Resource> {
        Self::list_page(env, start, limit).items
    }

    /// Paginated catalog page with next-cursor metadata.
    ///
    /// - `cursor` is a 0-based catalog index (same domain as `list`'s `start`).
    /// - `limit` is capped at 20.
    /// - `next_cursor` is `Some(next_index)` when more entries may exist after
    ///   this page, or `None` at end-of-list (including empty catalog / cursor
    ///   past the end).
    pub fn list_page(env: Env, cursor: u32, limit: u32) -> CatalogPage {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(20);
        let mut items: Vec<Resource> = Vec::new(&env);
        let mut i = cursor;
        while i < total && items.len() < page_size {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<DataKey, String>(&DataKey::Index(i))
            {
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&DataKey::Resource(id))
                {
                    items.push_back(resource);
                }
            }
            i += 1;
        }
        let next_cursor = if i < total { Some(i) } else { None };
        CatalogPage { items, next_cursor }
    }

    /// Paginated list of resources whose `listed` flag is true, in insertion order.
    ///
    /// - Resources are ordered by registration sequence.
    /// - `limit` is capped at `20`.
    /// - Delisted resources are skipped; relisted resources will reappear.
    /// - Returns an empty `Vec` if no listed resources fall in range.
    pub fn list_listed(env: Env, start: u32, limit: u32) -> Vec<Resource> {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(20);
        let mut result: Vec<Resource> = Vec::new(&env);
        let mut i = start;
        while i < total && result.len() < page_size {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<DataKey, String>(&DataKey::Index(i))
            {
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&DataKey::Resource(id))
                {
                    if resource.listed {
                        result.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        result
    }

    /// Paginated list of resources whose `listed` flag is true, in insertion order.
    ///
    /// - Resources are ordered by registration sequence.
    /// - `limit` is capped at `20`.
    /// - Delisted resources are skipped; relisted resources will reappear.
    /// - Returns an empty `Vec` if no listed resources fall in range.
    pub fn list_listed(env: Env, start: u32, limit: u32) -> Vec<Resource> {
        let total: u32 = env.storage().instance().get(&DataKey::Count).unwrap_or(0);
        let page_size = limit.min(20);
        let mut result: Vec<Resource> = Vec::new(&env);
        let mut i = start;
        while i < total && result.len() < page_size {
            if let Some(id) = env
                .storage()
                .persistent()
                .get::<DataKey, String>(&DataKey::Index(i))
            {
                if let Some(resource) = env
                    .storage()
                    .persistent()
                    .get::<DataKey, Resource>(&DataKey::Resource(id))
                {
                    if resource.listed {
                        result.push_back(resource);
                    }
                }
            }
            i += 1;
        }
        result
    }

    /// Paginated listing of resources owned by `creator` in insertion order.
    ///
    /// - Results are ordered by global registration sequence for that creator.
    /// - `limit` is capped at `20`.
    /// - Returns empty `Vec` when `start` is beyond the creator's known items.
    pub fn list_by_creator(env: Env, creator: Address, start: u32, limit: u32) -> Vec<Resource> {
        let page_size = limit.min(20);
        let mut result: Vec<Resource> = Vec::new(&env);
        if page_size == 0 {
            return result;
        }

        let list = Self::creator_list(&env, &creator);
        let total = list.len() as u32;
        if start >= total {
            return result;
        }

        let mut idx = start;
        while result.len() < page_size && idx < total {
            let id = list.get(idx).unwrap();
            if let Some(resource) = env
                .storage()
                .persistent()
                .get::<DataKey, Resource>(&DataKey::Resource(id.clone()))
            {
                result.push_back(resource);
            }
            idx += 1;
        }
        result
    }

    /// Fetch a resource. Errors with `NotFound` if it does not exist.
    pub fn get(env: Env, id: String) -> Result<Resource, Error> {
        Self::validate_resource_id(&id)?;
        Self::load(&env, &id)
    }

    /// Whether a resource with `id` is registered.
    pub fn exists(env: Env, id: String) -> bool {
        Self::validate_resource_id(&id).is_ok() && env.storage().persistent().has(&DataKey::Resource(id))
    }

    /// Get the owner address of a resource. Errors with `NotFound` if it does not exist.
    pub fn get_owner(env: Env, id: String) -> Result<Address, Error> {
        Self::validate_resource_id(&id)?;
        let resource = Self::load(&env, &id)?;
        Ok(resource.creator)
    }

    /// Total number of resources successfully registered (monotonic; not decremented on transfer).
    pub fn count(env: Env) -> u32 {
        env.storage().instance().get(&DataKey::Count).unwrap_or(0)
    }

    /// Store a hash of creator marketplace terms.
    pub fn set_terms_hash(env: Env, creator: Address, terms_hash: String) -> Result<(), Error> {
        creator.require_auth();
        if terms_hash.len() > MAX_TERMS_HASH_LEN {
            return Err(Error::TermsHashTooLong);
        }
        let key = DataKey::CreatorTerms(creator.clone());
        env.storage().persistent().set(&key, &terms_hash);
        Self::bump_persistent(&env, &key);
        env.events().publish((symbol_short!("setterms"), creator), terms_hash);
        Ok(())
    }

    /// Fetch a creator's marketplace terms hash. Errors with `NotFound` if it does not exist.
    pub fn get_terms_hash(env: Env, creator: Address) -> Result<String, Error> {
        let key = DataKey::CreatorTerms(creator);
        env.storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotFound)
    }
}

impl VaultRegistry {
    fn is_reserved_id(id: &String) -> bool {
        use alloc::string::ToString;
        let id_str = id.to_string().to_lowercase();
        match id_str.as_str() {
            "admin" | "null" | "registry" | "api" | "index" | "root" | "system" => true,
            _ => false,
        }
    }

    fn validate_metadata_pointer(metadata: &String) -> Result<(), Error> {
        if metadata.len() > MAX_METADATA_POINTER_LEN {
            return Err(Error::MetadataTooLong);
        }

        let metadata_str = metadata.to_string();
        if metadata_str.starts_with("ipfs://")
            || metadata_str.starts_with("ar://")
            || metadata_str.starts_with("https://")
            || metadata_str.starts_with("http://")
            || metadata_str.starts_with("sha256:")
            || metadata_str.starts_with("sha-256:")
            || metadata_str.starts_with("0x")
        {
            Ok(())
        } else {
            Err(Error::InvalidMetadataPointer)
        }
    }

    fn validate_tags(_env: &Env, tags: &Vec<String>) -> Result<(), Error> {
        if tags.len() > MAX_TAGS {
            return Err(Error::InvalidTag);
        }
        for i in 0..tags.len() {
            let tag = tags.get(i).unwrap();
            let len = tag.len();
            if len == 0 || len > MAX_TAG_LEN {
                return Err(Error::InvalidTag);
            }
        }
        Ok(())
    }

    fn load(env: &Env, id: &String) -> Result<Resource, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Resource(id.clone()))
            .ok_or(Error::NotFound)
    }

    fn save(env: &Env, resource: &Resource) {
        let key = DataKey::Resource(resource.id.clone());
        env.storage().persistent().set(&key, resource);
        Self::bump_persistent(env, &key);
    }

    /// Extend persistent entry TTL when below threshold (Soroban archival safety).
    fn bump_persistent<K>(env: &Env, key: &K)
    where
        K: IntoVal<Env, Val>,
    {
        env.storage()
            .persistent()
            .extend_ttl(key, LIFETIME_THRESHOLD, BUMP_AMOUNT);
    }

    fn bump_instance(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(LIFETIME_THRESHOLD, BUMP_AMOUNT);
    }

    fn creator_key(_env: &Env, creator: &Address) -> DataKey {
        DataKey::CreatorResources(creator.clone())
    }

    fn creator_list(env: &Env, creator: &Address) -> Vec<String> {
        env.storage()
            .persistent()
            .get::<DataKey, Vec<String>>(&Self::creator_key(env, creator))
            .unwrap_or_else(|| Vec::new(env))
    }

    fn append_to_creator_index(env: &Env, creator: &Address, id: String) {
        let mut list = Self::creator_list(env, creator);
        list.push_back(id);
        env.storage()
            .persistent()
            .set(&Self::creator_key(env, creator), &list);
        Self::bump_persistent(env, &Self::creator_key(env, creator));
    }

    fn remove_from_creator_index(env: &Env, creator: &Address, id: &String) {
        let list = Self::creator_list(env, creator);
        let mut out: Vec<String> = Vec::new(env);
        for i in 0..list.len() {
            let v = list.get(i).unwrap();
            if v != *id {
                out.push_back(v);
            }
        }
        env.storage()
            .persistent()
            .set(&Self::creator_key(env, creator), &out);
        Self::bump_persistent(env, &Self::creator_key(env, creator));
    }

    fn creator_count(env: &Env, creator: &Address) -> u32 {
        env.storage()
            .instance()
            .get::<_, u32>(&DataKey::CreatorCount(creator.clone()))
            .unwrap_or(0)
    }

    fn set_creator_count(env: &Env, creator: &Address, value: u32) {
        env.storage()
            .instance()
            .set(&DataKey::CreatorCount(creator.clone()), &value);
        Self::bump_instance(env);
    }
}

#[cfg(test)]
pub(crate) const TTL_BUMP_AMOUNT: u32 = BUMP_AMOUNT;

mod test;
