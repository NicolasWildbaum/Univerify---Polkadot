import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { Abi, Address, Hex, Log } from "viem";
import { getAddress, keccak256, parseEventLogs, toBytes } from "viem";
import {
	computeClaimsHash,
	deriveCertificateId,
	computeRecipientCommitment,
	buildCredential,
	type CredentialClaims,
} from "../src/credential";

// ── IssuerStatus mirror (must match contracts/Univerify.sol) ──────────
const STATUS_NONE = 0;
const STATUS_PENDING = 1;
const STATUS_ACTIVE = 2;
const STATUS_SUSPENDED = 3;

// ── Tuple decoders ───────────────────────────────────────────────────

/** Hardhat-viem returns struct returns as tuples (ABI component order). */
function readCertificateTuple(raw: readonly unknown[]) {
	const [issuer, claimsHash, recipientCommitment, issuedAt, revoked] = raw;
	return {
		issuer: issuer as Address,
		claimsHash: claimsHash as Hex,
		recipientCommitment: recipientCommitment as Hex,
		issuedAt: issuedAt as bigint,
		revoked: revoked as boolean,
	};
}

/** `getIssuer()` returns the Issuer struct with named fields; viem surfaces
 *  those as an object, not a tuple. */
function readIssuerStruct(raw: unknown) {
	const o = raw as {
		account: Address;
		status: number | bigint;
		metadataHash: Hex;
		name: string;
		registeredAt: bigint;
		approvalCount: number | bigint;
	};
	return {
		account: o.account,
		status: Number(o.status),
		metadataHash: o.metadataHash,
		name: o.name,
		registeredAt: o.registeredAt,
		approvalCount: Number(o.approvalCount),
	};
}

// ── Revert helpers ───────────────────────────────────────────────────

/** Asserts a viem contract error carries the given Solidity custom error name. */
function expectCustomError(err: unknown, errorName: string) {
	const parts: string[] = [];
	let cur: unknown = err;
	let depth = 0;
	while (cur !== undefined && cur !== null && depth < 12) {
		if (cur instanceof Error) {
			const e = cur as Error & {
				cause?: unknown;
				details?: string;
				shortMessage?: string;
			};
			parts.push(e.message, e.name);
			if (e.details) parts.push(e.details);
			if (e.shortMessage) parts.push(e.shortMessage);
			cur = e.cause;
		} else {
			parts.push(String(cur));
			break;
		}
		depth++;
	}
	const joined = parts.join("\n");
	expect(joined, `expected revert containing ${errorName}`).to.include(errorName);
}

/** Runs `fn` and asserts it reverts with the given custom error. */
async function expectRevert(fn: () => Promise<unknown>, errorName: string) {
	try {
		await fn();
	} catch (e: unknown) {
		expectCustomError(e, errorName);
		return;
	}
	throw new Error(`Expected revert with ${errorName} but call succeeded`);
}

// ── Typed event-log helpers ──────────────────────────────────────────
// viem's `parseEventLogs` widens to `never[]` when the ABI type isn't narrowed
// (our case, since hardhat-viem contracts carry a runtime ABI). A tiny
// generic wrapper restores access to `args` without resorting to `any`.

type EventLog<Args> = { args: Args; eventName: string };

function parseLogs<Args extends Record<string, unknown>>(
	abi: Abi,
	logs: readonly Log[],
	eventName: string,
): Array<EventLog<Args>> {
	return parseEventLogs({
		abi,
		logs: logs as Log[],
		eventName,
	}) as unknown as Array<EventLog<Args>>;
}

async function getConstructorEvents<Args extends Record<string, unknown>>(
	publicClient: Awaited<ReturnType<typeof hre.viem.getPublicClient>>,
	address: Address,
	abi: Abi,
	eventName: string,
): Promise<Array<EventLog<Args>>> {
	const logs = await publicClient.getContractEvents({
		address,
		abi,
		eventName,
		fromBlock: 0n,
	});
	return logs as unknown as Array<EventLog<Args>>;
}

// Event argument shapes (mirror contract events)
type ApplyArgs = { issuer: Address; name: string; metadataHash: Hex };
type ApproveArgs = { approver: Address; issuer: Address; approvalCount: number | bigint };
type IssuerAddrArgs = { issuer: Address };
type OwnershipArgs = { previousOwner: Address; newOwner: Address };
type CertArgs = { certificateId: Hex; issuer: Address };

// ── Test data ────────────────────────────────────────────────────────

const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const metaUdelar = keccak256(toBytes("udelar-metadata"));
const metaUm = keccak256(toBytes("universidad-de-montevideo-metadata"));
const metaOrt = keccak256(toBytes("ort-metadata"));
const metaApplicant = keccak256(toBytes("applicant-metadata"));

const certificateId = keccak256(toBytes("cert-001"));
const certificateId2 = keccak256(toBytes("cert-002"));
const claimsHash = keccak256(toBytes("canonical-claims-json"));
const claimsHash2 = keccak256(toBytes("canonical-claims-json-2"));
const recipientCommitment = keccak256(toBytes("recipient-secret-commitment"));

const GENESIS_NAMES = ["UDELAR", "University of Montevideo", "University ORT"] as const;
const DEFAULT_THRESHOLD = 2;

// ── Fixtures ─────────────────────────────────────────────────────────

async function deployWithGenesis() {
	const [owner, alice, bob, charlie, applicant, stranger] = await hre.viem.getWalletClients();
	const publicClient = await hre.viem.getPublicClient();

	const genesis = [
		{ account: alice.account.address, name: GENESIS_NAMES[0], metadataHash: metaUdelar },
		{ account: bob.account.address, name: GENESIS_NAMES[1], metadataHash: metaUm },
		{ account: charlie.account.address, name: GENESIS_NAMES[2], metadataHash: metaOrt },
	];

	const univerify = await hre.viem.deployContract("Univerify", [genesis, DEFAULT_THRESHOLD]);

	return {
		univerify,
		owner,
		alice,
		bob,
		charlie,
		applicant,
		stranger,
		publicClient,
		genesis,
		threshold: DEFAULT_THRESHOLD,
	};
}

async function deployWithPendingApplicant() {
	const ctx = await loadFixture(deployWithGenesis);
	await ctx.univerify.write.applyAsIssuer(["Applicant University", metaApplicant], {
		account: ctx.applicant.account,
	});
	return ctx;
}

// ── Suite ────────────────────────────────────────────────────────────

describe("Univerify", function () {
	// ── Deployment / Constructor ─────────────────────────────────────

	describe("Deployment", function () {
		it("sets deployer as owner", async function () {
			const { univerify, owner } = await loadFixture(deployWithGenesis);
			expect(getAddress((await univerify.read.owner()) as Address)).to.equal(
				getAddress(owner.account.address),
			);
		});

		it("stores approvalThreshold as immutable", async function () {
			const { univerify, threshold } = await loadFixture(deployWithGenesis);
			expect(Number(await univerify.read.approvalThreshold())).to.equal(threshold);
		});

		it("seeds each genesis issuer as Active with full profile", async function () {
			const { univerify, genesis } = await loadFixture(deployWithGenesis);
			for (const g of genesis) {
				const profile = readIssuerStruct(
					(await univerify.read.getIssuer([g.account])) as readonly unknown[],
				);
				expect(getAddress(profile.account)).to.equal(getAddress(g.account));
				expect(profile.status).to.equal(STATUS_ACTIVE);
				expect(profile.metadataHash).to.equal(g.metadataHash);
				expect(profile.name).to.equal(g.name);
				expect(profile.registeredAt > 0n).to.equal(true);
				expect(profile.approvalCount).to.equal(0);
				expect(await univerify.read.isActiveIssuer([g.account])).to.equal(true);
			}
		});

		it("populates the enumeration list with every genesis issuer", async function () {
			const { univerify, genesis } = await loadFixture(deployWithGenesis);
			expect((await univerify.read.issuerCount()) as bigint).to.equal(BigInt(genesis.length));
			for (let i = 0; i < genesis.length; i++) {
				expect(
					getAddress((await univerify.read.issuerAt([BigInt(i)])) as Address),
				).to.equal(getAddress(genesis[i].account));
			}
		});

		it("emits OwnershipTransferred and one IssuerActivated per genesis issuer", async function () {
			const { univerify, owner, publicClient, genesis } =
				await loadFixture(deployWithGenesis);

			const ownershipLogs = await getConstructorEvents<OwnershipArgs>(
				publicClient,
				univerify.address,
				univerify.abi as Abi,
				"OwnershipTransferred",
			);
			expect(ownershipLogs).to.have.lengthOf(1);
			expect(getAddress(ownershipLogs[0].args.previousOwner)).to.equal(
				getAddress(ZERO_ADDRESS),
			);
			expect(getAddress(ownershipLogs[0].args.newOwner)).to.equal(
				getAddress(owner.account.address),
			);

			const activatedLogs = await getConstructorEvents<IssuerAddrArgs>(
				publicClient,
				univerify.address,
				univerify.abi as Abi,
				"IssuerActivated",
			);
			expect(activatedLogs).to.have.lengthOf(genesis.length);
			const emittedAddrs = activatedLogs.map((l) => getAddress(l.args.issuer));
			for (const g of genesis) {
				expect(emittedAddrs).to.include(getAddress(g.account));
			}
		});

		it("reverts InvalidThreshold when threshold is zero", async function () {
			const [, alice] = await hre.viem.getWalletClients();
			await expectRevert(
				() =>
					hre.viem.deployContract("Univerify", [
						[
							{
								account: alice.account.address,
								name: "X",
								metadataHash: metaUdelar,
							},
						],
						0,
					]),
				"InvalidThreshold",
			);
		});

		it("reverts InvalidGenesis when the genesis list is empty", async function () {
			await expectRevert(
				() => hre.viem.deployContract("Univerify", [[], 1]),
				"InvalidGenesis",
			);
		});

		it("reverts InvalidGenesis when threshold > genesis length", async function () {
			const [, alice] = await hre.viem.getWalletClients();
			await expectRevert(
				() =>
					hre.viem.deployContract("Univerify", [
						[
							{
								account: alice.account.address,
								name: "X",
								metadataHash: metaUdelar,
							},
						],
						2,
					]),
				"InvalidGenesis",
			);
		});

		it("reverts ZeroAddress on a zero-address genesis entry", async function () {
			await expectRevert(
				() =>
					hre.viem.deployContract("Univerify", [
						[{ account: ZERO_ADDRESS, name: "X", metadataHash: metaUdelar }],
						1,
					]),
				"ZeroAddress",
			);
		});

		it("reverts EmptyName on an empty genesis name", async function () {
			const [, alice] = await hre.viem.getWalletClients();
			await expectRevert(
				() =>
					hre.viem.deployContract("Univerify", [
						[
							{
								account: alice.account.address,
								name: "",
								metadataHash: metaUdelar,
							},
						],
						1,
					]),
				"EmptyName",
			);
		});

		it("reverts NameTooLong when a genesis name exceeds MAX_NAME_LENGTH", async function () {
			const [, alice] = await hre.viem.getWalletClients();
			const tooLong = "x".repeat(65); // MAX_NAME_LENGTH = 64
			await expectRevert(
				() =>
					hre.viem.deployContract("Univerify", [
						[
							{
								account: alice.account.address,
								name: tooLong,
								metadataHash: metaUdelar,
							},
						],
						1,
					]),
				"NameTooLong",
			);
		});

		it("reverts IssuerAlreadyExists on a duplicated genesis entry", async function () {
			const [, alice] = await hre.viem.getWalletClients();
			await expectRevert(
				() =>
					hre.viem.deployContract("Univerify", [
						[
							{
								account: alice.account.address,
								name: "A",
								metadataHash: metaUdelar,
							},
							{
								account: alice.account.address,
								name: "A-dup",
								metadataHash: metaUm,
							},
						],
						1,
					]),
				"IssuerAlreadyExists",
			);
		});
	});

	// ── Governance: applyAsIssuer ────────────────────────────────────

	describe("applyAsIssuer", function () {
		it("moves caller from None to Pending with a full profile", async function () {
			const { univerify, applicant } = await loadFixture(deployWithGenesis);
			await univerify.write.applyAsIssuer(["Applicant University", metaApplicant], {
				account: applicant.account,
			});
			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([applicant.account.address])) as readonly unknown[],
			);
			expect(getAddress(profile.account)).to.equal(getAddress(applicant.account.address));
			expect(profile.status).to.equal(STATUS_PENDING);
			expect(profile.metadataHash).to.equal(metaApplicant);
			expect(profile.name).to.equal("Applicant University");
			expect(profile.registeredAt > 0n).to.equal(true);
			expect(profile.approvalCount).to.equal(0);
			expect(await univerify.read.isActiveIssuer([applicant.account.address])).to.equal(
				false,
			);
		});

		it("appends the applicant to the enumeration list", async function () {
			const { univerify, applicant, genesis } = await loadFixture(deployWithGenesis);
			const before = (await univerify.read.issuerCount()) as bigint;
			await univerify.write.applyAsIssuer(["Applicant University", metaApplicant], {
				account: applicant.account,
			});
			const after = (await univerify.read.issuerCount()) as bigint;
			expect(after - before).to.equal(1n);
			expect(
				getAddress((await univerify.read.issuerAt([BigInt(genesis.length)])) as Address),
			).to.equal(getAddress(applicant.account.address));
		});

		it("emits IssuerApplied with name and metadataHash", async function () {
			const { univerify, applicant, publicClient } = await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.applyAsIssuer(
				["Applicant University", metaApplicant],
				{ account: applicant.account },
			);
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<ApplyArgs>(univerify.abi as Abi, receipt.logs, "IssuerApplied");
			expect(logs).to.have.lengthOf(1);
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(applicant.account.address));
			expect(logs[0].args.name).to.equal("Applicant University");
			expect(logs[0].args.metadataHash).to.equal(metaApplicant);
		});

		it("reverts EmptyName on an empty name", async function () {
			const { univerify, applicant } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.applyAsIssuer(["", metaApplicant], {
						account: applicant.account,
					}),
				"EmptyName",
			);
		});

		it("reverts NameTooLong on a name longer than MAX_NAME_LENGTH", async function () {
			const { univerify, applicant } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.applyAsIssuer(["x".repeat(65), metaApplicant], {
						account: applicant.account,
					}),
				"NameTooLong",
			);
		});

		it("reverts IssuerAlreadyExists when a genesis issuer re-applies", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.applyAsIssuer(["UDELAR-dup", metaUdelar], {
						account: alice.account,
					}),
				"IssuerAlreadyExists",
			);
		});

		it("reverts IssuerAlreadyExists when a Pending applicant re-applies", async function () {
			const { univerify, applicant } = await loadFixture(deployWithPendingApplicant);
			await expectRevert(
				() =>
					univerify.write.applyAsIssuer(["Applicant-dup", metaApplicant], {
						account: applicant.account,
					}),
				"IssuerAlreadyExists",
			);
		});

		it("reverts IssuerAlreadyExists when a Suspended issuer re-applies", async function () {
			const { univerify, owner, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.applyAsIssuer(["UDELAR-again", metaUdelar], {
						account: alice.account,
					}),
				"IssuerAlreadyExists",
			);
		});
	});

	// ── Governance: approveIssuer ────────────────────────────────────

	describe("approveIssuer", function () {
		it("increments approvalCount and emits IssuerApproved", async function () {
			const { univerify, alice, applicant, publicClient } = await loadFixture(
				deployWithPendingApplicant,
			);
			const txHash = await univerify.write.approveIssuer([applicant.account.address], {
				account: alice.account,
			});

			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([applicant.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_PENDING);
			expect(profile.approvalCount).to.equal(1);

			expect(
				await univerify.read.hasApproved([
					applicant.account.address,
					alice.account.address,
				]),
			).to.equal(true);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<ApproveArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"IssuerApproved",
			);
			expect(logs).to.have.lengthOf(1);
			expect(getAddress(logs[0].args.approver)).to.equal(getAddress(alice.account.address));
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(applicant.account.address));
			expect(Number(logs[0].args.approvalCount)).to.equal(1);
		});

		it("promotes the candidate to Active atomically once threshold is reached", async function () {
			const { univerify, alice, bob, applicant, publicClient } = await loadFixture(
				deployWithPendingApplicant,
			);

			await univerify.write.approveIssuer([applicant.account.address], {
				account: alice.account,
			});
			const txHash = await univerify.write.approveIssuer([applicant.account.address], {
				account: bob.account,
			});

			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([applicant.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_ACTIVE);
			expect(profile.approvalCount).to.equal(DEFAULT_THRESHOLD);
			expect(await univerify.read.isActiveIssuer([applicant.account.address])).to.equal(true);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const activatedLogs = parseLogs<IssuerAddrArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"IssuerActivated",
			);
			expect(activatedLogs).to.have.lengthOf(1);
			expect(getAddress(activatedLogs[0].args.issuer)).to.equal(
				getAddress(applicant.account.address),
			);
		});

		it("reverts NotActiveIssuer when caller is not an Active issuer", async function () {
			const { univerify, stranger, applicant } = await loadFixture(
				deployWithPendingApplicant,
			);
			await expectRevert(
				() =>
					univerify.write.approveIssuer([applicant.account.address], {
						account: stranger.account,
					}),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when a Pending applicant tries to approve another Pending", async function () {
			const { univerify, applicant, stranger } = await loadFixture(
				deployWithPendingApplicant,
			);
			await univerify.write.applyAsIssuer(["Second Applicant", metaApplicant], {
				account: stranger.account,
			});
			await expectRevert(
				() =>
					univerify.write.approveIssuer([stranger.account.address], {
						account: applicant.account,
					}),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when a Suspended issuer tries to approve", async function () {
			const { univerify, owner, alice, applicant } = await loadFixture(
				deployWithPendingApplicant,
			);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.approveIssuer([applicant.account.address], {
						account: alice.account,
					}),
				"NotActiveIssuer",
			);
		});

		it("reverts CannotApproveSelf", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.approveIssuer([alice.account.address], {
						account: alice.account,
					}),
				"CannotApproveSelf",
			);
		});

		it("reverts IssuerNotPending when candidate is unknown", async function () {
			const { univerify, alice, stranger } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.approveIssuer([stranger.account.address], {
						account: alice.account,
					}),
				"IssuerNotPending",
			);
		});

		it("reverts IssuerNotPending when candidate is already Active", async function () {
			const { univerify, alice, bob } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.approveIssuer([bob.account.address], {
						account: alice.account,
					}),
				"IssuerNotPending",
			);
		});

		it("reverts IssuerNotPending when candidate is Suspended", async function () {
			const { univerify, owner, alice, bob } = await loadFixture(deployWithGenesis);
			await univerify.write.suspendIssuer([bob.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.approveIssuer([bob.account.address], {
						account: alice.account,
					}),
				"IssuerNotPending",
			);
		});

		it("reverts AlreadyApproved on a second approval from the same issuer", async function () {
			const { univerify, alice, applicant } = await loadFixture(deployWithPendingApplicant);
			await univerify.write.approveIssuer([applicant.account.address], {
				account: alice.account,
			});
			await expectRevert(
				() =>
					univerify.write.approveIssuer([applicant.account.address], {
						account: alice.account,
					}),
				"AlreadyApproved",
			);
		});

		it("preserves historical approval records after the approver is suspended", async function () {
			const { univerify, owner, alice, applicant } = await loadFixture(
				deployWithPendingApplicant,
			);
			await univerify.write.approveIssuer([applicant.account.address], {
				account: alice.account,
			});
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			expect(
				await univerify.read.hasApproved([
					applicant.account.address,
					alice.account.address,
				]),
			).to.equal(true);
			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([applicant.account.address])) as readonly unknown[],
			);
			expect(profile.approvalCount).to.equal(1);
		});
	});

	// ── Governance: emergency admin ──────────────────────────────────

	describe("suspendIssuer / unsuspendIssuer", function () {
		it("owner can suspend an Active issuer and emits IssuerSuspended", async function () {
			const { univerify, owner, alice, publicClient } = await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([alice.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_SUSPENDED);
			expect(await univerify.read.isActiveIssuer([alice.account.address])).to.equal(false);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<IssuerAddrArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"IssuerSuspended",
			);
			expect(logs).to.have.lengthOf(1);
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(alice.account.address));
		});

		it("owner can unsuspend a Suspended issuer and emits IssuerUnsuspended", async function () {
			const { univerify, owner, alice, publicClient } = await loadFixture(deployWithGenesis);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			const txHash = await univerify.write.unsuspendIssuer([alice.account.address], {
				account: owner.account,
			});
			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([alice.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_ACTIVE);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<IssuerAddrArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"IssuerUnsuspended",
			);
			expect(logs).to.have.lengthOf(1);
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(alice.account.address));
		});

		it("reverts NotOwner when a non-owner tries to suspend", async function () {
			const { univerify, alice, bob } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.suspendIssuer([bob.account.address], {
						account: alice.account,
					}),
				"NotOwner",
			);
		});

		it("reverts NotOwner when a non-owner tries to unsuspend", async function () {
			const { univerify, owner, alice, bob } = await loadFixture(deployWithGenesis);
			await univerify.write.suspendIssuer([bob.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.unsuspendIssuer([bob.account.address], {
						account: alice.account,
					}),
				"NotOwner",
			);
		});

		it("reverts IssuerNotFound when suspending an unknown address", async function () {
			const { univerify, owner, stranger } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.suspendIssuer([stranger.account.address], {
						account: owner.account,
					}),
				"IssuerNotFound",
			);
		});

		it("reverts IssuerNotActive when suspending a Pending applicant", async function () {
			const { univerify, owner, applicant } = await loadFixture(deployWithPendingApplicant);
			await expectRevert(
				() =>
					univerify.write.suspendIssuer([applicant.account.address], {
						account: owner.account,
					}),
				"IssuerNotActive",
			);
		});

		it("reverts IssuerNotActive on double suspension", async function () {
			const { univerify, owner, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.suspendIssuer([alice.account.address], {
						account: owner.account,
					}),
				"IssuerNotActive",
			);
		});

		it("reverts IssuerNotFound when unsuspending an unknown address", async function () {
			const { univerify, owner, stranger } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.unsuspendIssuer([stranger.account.address], {
						account: owner.account,
					}),
				"IssuerNotFound",
			);
		});

		it("reverts IssuerNotSuspended when unsuspending an Active issuer", async function () {
			const { univerify, owner, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.unsuspendIssuer([alice.account.address], {
						account: owner.account,
					}),
				"IssuerNotSuspended",
			);
		});
	});

	describe("transferOwnership", function () {
		it("transfers ownership and emits OwnershipTransferred", async function () {
			const { univerify, owner, stranger, publicClient } =
				await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.transferOwnership([stranger.account.address], {
				account: owner.account,
			});
			expect(getAddress((await univerify.read.owner()) as Address)).to.equal(
				getAddress(stranger.account.address),
			);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<OwnershipArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"OwnershipTransferred",
			);
			expect(logs).to.have.lengthOf(1);
			expect(getAddress(logs[0].args.previousOwner)).to.equal(
				getAddress(owner.account.address),
			);
			expect(getAddress(logs[0].args.newOwner)).to.equal(
				getAddress(stranger.account.address),
			);
		});

		it("reverts NotOwner when called by a non-owner", async function () {
			const { univerify, alice, stranger } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.transferOwnership([stranger.account.address], {
						account: alice.account,
					}),
				"NotOwner",
			);
		});

		it("reverts ZeroAddress on zero-address transfer target", async function () {
			const { univerify, owner } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.transferOwnership([ZERO_ADDRESS], {
						account: owner.account,
					}),
				"ZeroAddress",
			);
		});

		it("previous owner loses admin after transfer", async function () {
			const { univerify, owner, alice, stranger } = await loadFixture(deployWithGenesis);
			await univerify.write.transferOwnership([stranger.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.suspendIssuer([alice.account.address], {
						account: owner.account,
					}),
				"NotOwner",
			);
		});
	});

	// ── Certificate issuance ─────────────────────────────────────────

	describe("issueCertificate", function () {
		it("an Active issuer can issue a certificate and it is stored correctly", async function () {
			const { univerify, alice, publicClient } = await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

			const cert = readCertificateTuple(
				(await univerify.read.certificates([certificateId])) as readonly unknown[],
			);
			expect(getAddress(cert.issuer)).to.equal(getAddress(alice.account.address));
			expect(cert.claimsHash).to.equal(claimsHash);
			expect(cert.recipientCommitment).to.equal(recipientCommitment);
			expect(cert.issuedAt).to.equal(block.timestamp);
			expect(cert.revoked).to.equal(false);
		});

		it("emits CertificateIssued", async function () {
			const { univerify, alice, publicClient } = await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<CertArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"CertificateIssued",
			);
			expect(logs).to.have.lengthOf(1);
			expect(logs[0].args.certificateId).to.equal(certificateId);
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(alice.account.address));
		});

		it("returns the certificateId", async function () {
			const { univerify, alice, publicClient } = await loadFixture(deployWithGenesis);
			const { result } = await publicClient.simulateContract({
				address: univerify.address,
				abi: univerify.abi,
				functionName: "issueCertificate",
				args: [certificateId, claimsHash, recipientCommitment],
				account: alice.account,
			});
			expect(result).to.equal(certificateId);
		});

		it("reverts NotActiveIssuer when caller is unknown (None)", async function () {
			const { univerify, stranger } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment],
						{ account: stranger.account },
					),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when caller is Pending", async function () {
			const { univerify, applicant } = await loadFixture(deployWithPendingApplicant);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment],
						{ account: applicant.account },
					),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when caller has been suspended", async function () {
			const { univerify, owner, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment],
						{ account: alice.account },
					),
				"NotActiveIssuer",
			);
		});

		it("reverts InvalidCertificateId on zero id", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[ZERO_BYTES32, claimsHash, recipientCommitment],
						{ account: alice.account },
					),
				"InvalidCertificateId",
			);
		});

		it("reverts InvalidClaimsHash on zero claims hash", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, ZERO_BYTES32, recipientCommitment],
						{ account: alice.account },
					),
				"InvalidClaimsHash",
			);
		});

		it("reverts InvalidRecipientCommitment on zero recipient commitment", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate([certificateId, claimsHash, ZERO_BYTES32], {
						account: alice.account,
					}),
				"InvalidRecipientCommitment",
			);
		});

		it("reverts CertificateAlreadyExists on duplicate id", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash2, recipientCommitment],
						{ account: alice.account },
					),
				"CertificateAlreadyExists",
			);
		});
	});

	// ── Certificate revocation ───────────────────────────────────────

	describe("revokeCertificate", function () {
		it("the original Active issuer can revoke and emits CertificateRevoked", async function () {
			const { univerify, alice, publicClient } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			const txHash = await univerify.write.revokeCertificate([certificateId], {
				account: alice.account,
			});

			const cert = readCertificateTuple(
				(await univerify.read.certificates([certificateId])) as readonly unknown[],
			);
			expect(cert.revoked).to.equal(true);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<CertArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"CertificateRevoked",
			);
			expect(logs).to.have.lengthOf(1);
			expect(logs[0].args.certificateId).to.equal(certificateId);
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(alice.account.address));
		});

		it("reverts InvalidCertificateId on zero id", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.revokeCertificate([ZERO_BYTES32], {
						account: alice.account,
					}),
				"InvalidCertificateId",
			);
		});

		it("reverts CertificateNotFound when the certificate does not exist", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.revokeCertificate([certificateId], {
						account: alice.account,
					}),
				"CertificateNotFound",
			);
		});

		it("reverts NotCertificateIssuer when another Active issuer tries to revoke", async function () {
			const { univerify, alice, bob } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			await expectRevert(
				() =>
					univerify.write.revokeCertificate([certificateId], {
						account: bob.account,
					}),
				"NotCertificateIssuer",
			);
		});

		it("reverts CertificateAlreadyRevoked on double revocation", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			await univerify.write.revokeCertificate([certificateId], {
				account: alice.account,
			});
			await expectRevert(
				() =>
					univerify.write.revokeCertificate([certificateId], {
						account: alice.account,
					}),
				"CertificateAlreadyRevoked",
			);
		});

		it("reverts NotActiveIssuer when the original issuer has been suspended", async function () {
			// Documents the intentional design: suspended issuers cannot revoke their own certs.
			const { univerify, owner, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			await expectRevert(
				() =>
					univerify.write.revokeCertificate([certificateId], {
						account: alice.account,
					}),
				"NotActiveIssuer",
			);
		});
	});

	// ── Verification ─────────────────────────────────────────────────

	describe("verifyCertificate", function () {
		it("returns exists=false for an unknown certificateId", async function () {
			const { univerify } = await loadFixture(deployWithGenesis);
			const [exists, issuer, hashMatch, revoked, issuedAt] =
				(await univerify.read.verifyCertificate([certificateId, claimsHash])) as readonly [
					boolean,
					Address,
					boolean,
					boolean,
					bigint,
				];
			expect(exists).to.equal(false);
			expect(getAddress(issuer)).to.equal(getAddress(ZERO_ADDRESS));
			expect(hashMatch).to.equal(false);
			expect(revoked).to.equal(false);
			expect(issuedAt).to.equal(0n);
		});

		it("returns hashMatch=true when claimsHash matches", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			const [exists, certIssuer, hashMatch, revoked, issuedAt] =
				(await univerify.read.verifyCertificate([certificateId, claimsHash])) as readonly [
					boolean,
					Address,
					boolean,
					boolean,
					bigint,
				];
			expect(exists).to.equal(true);
			expect(getAddress(certIssuer)).to.equal(getAddress(alice.account.address));
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(false);
			expect(issuedAt > 0n).to.equal(true);
		});

		it("returns hashMatch=false when claimsHash does not match", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			const wrongHash = keccak256(toBytes("tampered-claims"));
			const [exists, , hashMatch] = (await univerify.read.verifyCertificate([
				certificateId,
				wrongHash,
			])) as readonly [boolean, Address, boolean, boolean, bigint];
			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(false);
		});

		it("reports revoked=true and still reports hashMatch after revocation", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			await univerify.write.revokeCertificate([certificateId], {
				account: alice.account,
			});
			const [exists, , hashMatch, revoked] = (await univerify.read.verifyCertificate([
				certificateId,
				claimsHash,
			])) as readonly [boolean, Address, boolean, boolean, bigint];
			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(true);
		});

		it("still verifies a certificate issued by an issuer that was later suspended", async function () {
			// The contract deliberately does not track issuer status on the certificate itself.
			const { univerify, owner, alice } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: alice.account },
			);
			await univerify.write.suspendIssuer([alice.account.address], {
				account: owner.account,
			});
			const [exists, certIssuer, hashMatch, revoked] =
				(await univerify.read.verifyCertificate([certificateId, claimsHash])) as readonly [
					boolean,
					Address,
					boolean,
					boolean,
					bigint,
				];
			expect(exists).to.equal(true);
			expect(getAddress(certIssuer)).to.equal(getAddress(alice.account.address));
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(false);
		});
	});

	// ── Read helpers ─────────────────────────────────────────────────

	describe("Read helpers", function () {
		it("getIssuer returns a zeroed struct with status=None for unknown addresses", async function () {
			const { univerify, stranger } = await loadFixture(deployWithGenesis);
			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([stranger.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_NONE);
			expect(getAddress(profile.account)).to.equal(getAddress(ZERO_ADDRESS));
			expect(profile.name).to.equal("");
			expect(profile.metadataHash).to.equal(ZERO_BYTES32);
			expect(profile.registeredAt).to.equal(0n);
			expect(profile.approvalCount).to.equal(0);
		});

		it("isActiveIssuer is true only for Active issuers", async function () {
			const { univerify, owner, alice, bob, applicant, stranger } = await loadFixture(
				deployWithPendingApplicant,
			);
			expect(await univerify.read.isActiveIssuer([alice.account.address])).to.equal(true);
			expect(await univerify.read.isActiveIssuer([applicant.account.address])).to.equal(
				false,
			);
			expect(await univerify.read.isActiveIssuer([stranger.account.address])).to.equal(false);
			await univerify.write.suspendIssuer([bob.account.address], {
				account: owner.account,
			});
			expect(await univerify.read.isActiveIssuer([bob.account.address])).to.equal(false);
		});

		it("hasApproved is false when no approval has happened", async function () {
			const { univerify, alice, applicant } = await loadFixture(deployWithPendingApplicant);
			expect(
				await univerify.read.hasApproved([
					applicant.account.address,
					alice.account.address,
				]),
			).to.equal(false);
		});

		it("issuerCount and issuerAt expose genesis first, then applicants in apply order", async function () {
			const { univerify, applicant, stranger, genesis } =
				await loadFixture(deployWithGenesis);
			await univerify.write.applyAsIssuer(["Applicant", metaApplicant], {
				account: applicant.account,
			});
			await univerify.write.applyAsIssuer(["Stranger Uni", metaApplicant], {
				account: stranger.account,
			});
			expect((await univerify.read.issuerCount()) as bigint).to.equal(
				BigInt(genesis.length + 2),
			);
			expect(
				getAddress((await univerify.read.issuerAt([BigInt(genesis.length)])) as Address),
			).to.equal(getAddress(applicant.account.address));
			expect(
				getAddress(
					(await univerify.read.issuerAt([BigInt(genesis.length + 1)])) as Address,
				),
			).to.equal(getAddress(stranger.account.address));
		});
	});

	// ── Privacy invariant ────────────────────────────────────────────

	describe("Privacy", function () {
		it("does not expose certificate enumeration or listing functions", async function () {
			const { univerify } = await loadFixture(deployWithGenesis);
			const fnNames = (univerify.abi as Abi)
				.filter(
					(item): item is Extract<Abi[number], { type: "function" }> =>
						item.type === "function",
				)
				.map((item) => item.name);
			expect(fnNames).to.not.include("getClaimCount");
			expect(fnNames).to.not.include("getClaimHashAtIndex");
			expect(fnNames).to.not.include("getCertificatesByStudent");
			expect(fnNames).to.not.include("getAllCertificates");
		});
	});

	// ── End-to-end with canonical credential hashing ─────────────────

	describe("End-to-end with canonical credential hashing", function () {
		const sampleClaims: CredentialClaims = {
			degreeTitle: "Bachelor of Computer Science",
			holderName: "Maria Garcia",
			institutionName: "UDELAR",
			issuanceDate: "2026-03-15",
		};
		const internalRef = "UDELAR-CS-2026-00142";
		const secret = keccak256(toBytes("holder-secret-entropy"));
		const holderIdentifier = "maria.garcia@udelar.edu";

		it("issues and verifies with buildCredential", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);

			const built = buildCredential({
				issuer: alice.account.address,
				internalRef,
				claims: sampleClaims,
				secret,
				holderIdentifier,
			});

			await univerify.write.issueCertificate(
				[built.certificateId, built.claimsHash, built.recipientCommitment],
				{ account: alice.account },
			);

			const [exists, certIssuer, hashMatch, revoked, issuedAt] =
				(await univerify.read.verifyCertificate([
					built.certificateId,
					built.claimsHash,
				])) as readonly [boolean, Address, boolean, boolean, bigint];

			expect(exists).to.equal(true);
			expect(getAddress(certIssuer)).to.equal(getAddress(alice.account.address));
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(false);
			expect(issuedAt > 0n).to.equal(true);
		});

		it("detects tampered claims via hash mismatch", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);

			const built = buildCredential({
				issuer: alice.account.address,
				internalRef,
				claims: sampleClaims,
				secret,
				holderIdentifier,
			});

			await univerify.write.issueCertificate(
				[built.certificateId, built.claimsHash, built.recipientCommitment],
				{ account: alice.account },
			);

			const tamperedHash = computeClaimsHash({
				...sampleClaims,
				degreeTitle: "Master of Computer Science",
			});

			const [exists, , hashMatch] = (await univerify.read.verifyCertificate([
				built.certificateId,
				tamperedHash,
			])) as readonly [boolean, Address, boolean, boolean, bigint];

			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(false);
		});

		it("produces deterministic hashes for identical claims", function () {
			const h1 = computeClaimsHash(sampleClaims);
			const h2 = computeClaimsHash({ ...sampleClaims });
			expect(h1).to.equal(h2);
		});

		it("produces different hashes for different claims", function () {
			const h1 = computeClaimsHash(sampleClaims);
			const h2 = computeClaimsHash({ ...sampleClaims, holderName: "Juan Perez" });
			expect(h1).to.not.equal(h2);
		});

		it("produces different certificateIds for different refs", function () {
			const addr = "0x0000000000000000000000000000000000000001" as Hex;
			expect(deriveCertificateId(addr, "REF-001")).to.not.equal(
				deriveCertificateId(addr, "REF-002"),
			);
		});

		it("produces different recipient commitments for different holders", function () {
			expect(computeRecipientCommitment(secret, "alice@uni.edu")).to.not.equal(
				computeRecipientCommitment(secret, "bob@uni.edu"),
			);
		});

		it("keeps certificateId2 distinct from certificateId", function () {
			expect(certificateId).to.not.equal(certificateId2);
		});
	});
});
