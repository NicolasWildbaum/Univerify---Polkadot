use clap::Subcommand;
use k256::ecdsa::SigningKey;
use serde::Deserialize;
use sha3::{Digest, Keccak256};
use std::fs;
use std::path::PathBuf;

const ALICE_KEY: &str = "5fb92d6e98884f76de468fa3f6278f8807c48bebc13595d45af5bdc4da702133";
const BOB_KEY: &str = "8075991ce870b93a8870eca0c0f91913d12f47948ca0fd25b49c6fa7cdbeee8b";
const CHARLIE_KEY: &str = "0b6e18cafb6ed99687ec547bd28139cafbd3a4f28014f8640076aba0082bf262";

#[derive(Debug, Deserialize)]
pub struct Deployments {
    pub evm: Option<String>,
    pub pvm: Option<String>,
}

#[derive(Subcommand)]
pub enum ContractAction {
    /// Show deployed contract addresses and dev accounts
    Info,
    /// Get the counter value for an account via eth-rpc
    Get {
        /// Contract type: evm or pvm
        #[arg(value_parser = ["evm", "pvm"])]
        contract_type: String,
        /// Account name (alice, bob, charlie) or Ethereum address (0x...)
        #[arg(default_value = "alice")]
        account: String,
    },
}

fn private_key_to_address(key_hex: &str) -> String {
    let key_bytes = hex::decode(key_hex).expect("invalid hex key");
    let signing_key = SigningKey::from_slice(&key_bytes).expect("invalid private key");
    let verifying_key = signing_key.verifying_key();
    let public_key = verifying_key.to_encoded_point(false);
    let hash = Keccak256::digest(&public_key.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

fn resolve_account(account: &str) -> Result<String, Box<dyn std::error::Error>> {
    match account.to_lowercase().as_str() {
        "alice" => Ok(private_key_to_address(ALICE_KEY)),
        "bob" => Ok(private_key_to_address(BOB_KEY)),
        "charlie" => Ok(private_key_to_address(CHARLIE_KEY)),
        addr if addr.starts_with("0x") => Ok(addr.to_string()),
        _ => Err(format!("Unknown account: {account}. Use alice, bob, charlie, or an 0x address.").into()),
    }
}

fn load_deployments() -> Result<Deployments, Box<dyn std::error::Error>> {
    let paths = [
        PathBuf::from("deployments.json"),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../deployments.json"),
    ];
    for path in &paths {
        if path.exists() {
            let content = fs::read_to_string(path)?;
            return Ok(serde_json::from_str(&content)?);
        }
    }
    Err("deployments.json not found. Deploy contracts first.".into())
}

fn get_contract_address(
    deployments: &Deployments,
    contract_type: &str,
) -> Result<String, Box<dyn std::error::Error>> {
    let addr = match contract_type {
        "evm" => deployments.evm.as_deref(),
        "pvm" => deployments.pvm.as_deref(),
        _ => None,
    };
    addr.map(String::from).ok_or_else(|| {
        format!(
            "{} contract not deployed. Run: cd contracts/{} && npm run deploy:local",
            contract_type.to_uppercase(),
            contract_type
        )
        .into()
    })
}

fn function_selector(signature: &str) -> [u8; 4] {
    let hash = Keccak256::digest(signature.as_bytes());
    [hash[0], hash[1], hash[2], hash[3]]
}

pub async fn run(
    action: ContractAction,
    eth_rpc_url: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    match action {
        ContractAction::Info => {
            let deployments = load_deployments()?;
            println!("Deployed Contracts");
            println!("==================");
            println!(
                "EVM (solc):    {}",
                deployments.evm.as_deref().unwrap_or("not deployed")
            );
            println!(
                "PVM (resolc):  {}",
                deployments.pvm.as_deref().unwrap_or("not deployed")
            );
            println!();
            println!("Dev Accounts (Ethereum)");
            println!("=======================");
            println!("Alice:   {}", private_key_to_address(ALICE_KEY));
            println!("Bob:     {}", private_key_to_address(BOB_KEY));
            println!("Charlie: {}", private_key_to_address(CHARLIE_KEY));
        }
        ContractAction::Get {
            contract_type,
            account,
        } => {
            let deployments = load_deployments()?;
            let contract_addr = get_contract_address(&deployments, &contract_type)?;
            let eth_account = resolve_account(&account)?;

            // Build eth_call data: getCounter(address)
            let selector = function_selector("getCounter(address)");
            let addr_clean = eth_account
                .strip_prefix("0x")
                .unwrap_or(&eth_account)
                .to_lowercase();
            let calldata = format!("0x{}{:0>64}", hex::encode(selector), addr_clean);

            let client = reqwest::Client::new();
            let response: serde_json::Value = client
                .post(eth_rpc_url)
                .json(&serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "eth_call",
                    "params": [{
                        "to": contract_addr,
                        "data": calldata
                    }, "latest"],
                    "id": 1
                }))
                .send()
                .await?
                .json()
                .await?;

            if let Some(error) = response.get("error") {
                return Err(format!("RPC error: {error}").into());
            }

            let result = response["result"]
                .as_str()
                .ok_or("Invalid RPC response")?;

            let hex_str = result.strip_prefix("0x").unwrap_or(result);
            let value = if hex_str.is_empty() || hex_str.chars().all(|c| c == '0') {
                0u128
            } else {
                u128::from_str_radix(hex_str.trim_start_matches('0'), 16)?
            };

            println!(
                "Counter for {} on {} contract: {}",
                account,
                contract_type.to_uppercase(),
                value
            );
        }
    }

    Ok(())
}
