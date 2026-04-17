use crate::{
	AccountId, BalancesConfig, CollatorSelectionConfig, ParachainInfoConfig, PolkadotXcmConfig,
	RuntimeGenesisConfig, SessionConfig, SessionKeys, SudoConfig, EXISTENTIAL_DEPOSIT,
};

use alloc::{vec, vec::Vec};

use polkadot_sdk::{staging_xcm as xcm, *};

use cumulus_primitives_core::ParaId;
use frame_support::build_struct_json_patch;
use parachains_common::AuraId;
use serde_json::Value;
use sp_genesis_builder::PresetId;
use sp_keyring::Sr25519Keyring;
use xcm::prelude::XCM_VERSION;

/// The default XCM version to set in genesis config.
const SAFE_XCM_VERSION: u32 = XCM_VERSION;
/// Parachain id used for genesis config presets.
pub const PARACHAIN_ID: u32 = 1000;

/// Generate the session keys from individual elements.
pub fn template_session_keys(keys: AuraId) -> SessionKeys {
	SessionKeys { aura: keys }
}

fn testnet_genesis(
	invulnerables: Vec<(AccountId, AuraId)>,
	endowed_accounts: Vec<AccountId>,
	root: AccountId,
	id: ParaId,
) -> Value {
	build_struct_json_patch!(RuntimeGenesisConfig {
		balances: BalancesConfig {
			balances: endowed_accounts
				.iter()
				.cloned()
				.map(|k| (k, 1u128 << 60))
				.collect::<Vec<_>>(),
		},
		parachain_info: ParachainInfoConfig { parachain_id: id },
		collator_selection: CollatorSelectionConfig {
			invulnerables: invulnerables.iter().cloned().map(|(acc, _)| acc).collect::<Vec<_>>(),
			candidacy_bond: EXISTENTIAL_DEPOSIT * 16,
		},
		session: SessionConfig {
			keys: invulnerables
				.into_iter()
				.map(|(acc, aura)| { (acc.clone(), acc, template_session_keys(aura),) })
				.collect::<Vec<_>>(),
		},
		polkadot_xcm: PolkadotXcmConfig { safe_xcm_version: Some(SAFE_XCM_VERSION) },
		sudo: SudoConfig { key: Some(root) },
	})
}

fn local_testnet_genesis() -> Value {
	testnet_genesis(
		vec![
			(Sr25519Keyring::Alice.to_account_id(), Sr25519Keyring::Alice.public().into()),
			(Sr25519Keyring::Bob.to_account_id(), Sr25519Keyring::Bob.public().into()),
		],
		Sr25519Keyring::well_known().map(|k| k.to_account_id()).collect(),
		Sr25519Keyring::Alice.to_account_id(),
		PARACHAIN_ID.into(),
	)
}

/// Ethereum dev accounts (Moonbeam idx 0..4) with 0xEE padding to 32 bytes.
/// Frontend `web/src/config/evm.ts` exposes these as Alice / Bob / Charlie /
/// Dave / Eve. The first three are the genesis-active Univerify issuers; the
/// last two exist so the Governance UI can demonstrate the apply / approve
/// flow without touching the genesis set.
fn eth_dev_accounts() -> Vec<AccountId> {
	use sp_core::crypto::AccountId32;
	[
		// Alith → Alice
		hex_literal::hex!("f24ff3a9cf04c71dbc94d0b566f7a27b94566caceeeeeeeeeeeeeeeeeeeeeeee"),
		// Baltathar → Bob
		hex_literal::hex!("3cd0a705a2dc65e5b1e1205896baa2be8a07c6e0eeeeeeeeeeeeeeeeeeeeeeee"),
		// Charleth → Charlie
		hex_literal::hex!("798d4ba9baf0064ec19eb4f0a1a45785ae9d6dfceeeeeeeeeeeeeeeeeeeeeeee"),
		// Dorothy → Dave
		hex_literal::hex!("773539d4ac0e786233d90a233654ccee26a613d9eeeeeeeeeeeeeeeeeeeeeeee"),
		// Ethan → Eve
		hex_literal::hex!("ff64d3f6efe2317ee2807d223a0bdc4c0c49dfdbeeeeeeeeeeeeeeeeeeeeeeee"),
	]
	.into_iter()
	.map(AccountId32::from)
	.collect()
}

fn development_config_genesis() -> Value {
	let mut endowed: Vec<AccountId> =
		Sr25519Keyring::well_known().map(|k| k.to_account_id()).collect();
	endowed.extend(eth_dev_accounts());

	testnet_genesis(
		vec![
			(Sr25519Keyring::Alice.to_account_id(), Sr25519Keyring::Alice.public().into()),
			(Sr25519Keyring::Bob.to_account_id(), Sr25519Keyring::Bob.public().into()),
		],
		endowed,
		Sr25519Keyring::Alice.to_account_id(),
		PARACHAIN_ID.into(),
	)
}

/// Provides the JSON representation of predefined genesis config for given `id`.
pub fn get_preset(id: &PresetId) -> Option<vec::Vec<u8>> {
	let patch = match id.as_ref() {
		sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET => local_testnet_genesis(),
		sp_genesis_builder::DEV_RUNTIME_PRESET => development_config_genesis(),
		_ => return None,
	};
	Some(
		serde_json::to_string(&patch)
			.expect("serialization to json is expected to work. qed.")
			.into_bytes(),
	)
}

/// List of supported presets.
pub fn preset_names() -> Vec<PresetId> {
	vec![
		PresetId::from(sp_genesis_builder::DEV_RUNTIME_PRESET),
		PresetId::from(sp_genesis_builder::LOCAL_TESTNET_RUNTIME_PRESET),
	]
}
