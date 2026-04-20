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
const STATUS_REMOVED = 3;

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

/** `getRemovalProposal()` — same shape-handling notes as `getIssuer`. */
function readRemovalProposal(raw: unknown) {
	const o = raw as {
		target: Address;
		proposer: Address;
		createdAt: bigint;
		voteCount: number | bigint;
		executed: boolean;
	};
	return {
		target: o.target,
		proposer: o.proposer,
		createdAt: o.createdAt,
		voteCount: Number(o.voteCount),
		executed: o.executed,
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
type CertIssuedArgs = { certificateId: Hex; issuer: Address; student: Address };
type CertArgs = { certificateId: Hex; issuer: Address };
type RemovalCreatedArgs = {
	proposalId: bigint;
	target: Address;
	proposer: Address;
};
type RemovalVoteArgs = { proposalId: bigint; voter: Address; voteCount: number | bigint };
type RemovalExecutedArgs = { issuer: Address; proposalId: bigint };

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
//
// The first wallet client is the deployer — in the old model it was the
// contract "owner". With the federated refactor there is no owner, so the
// deployer is only used as the transaction signer during construction and
// to wire up the NFT (the one-shot `setCertificateNft` is permissionless and
// requires only that the NFT's `minter()` points back at the registry).

async function deployWithGenesis() {
	const [deployer, alice, bob, charlie, applicant, stranger, student] =
		await hre.viem.getWalletClients();
	const publicClient = await hre.viem.getPublicClient();

	const genesis = [
		{ account: alice.account.address, name: GENESIS_NAMES[0], metadataHash: metaUdelar },
		{ account: bob.account.address, name: GENESIS_NAMES[1], metadataHash: metaUm },
		{ account: charlie.account.address, name: GENESIS_NAMES[2], metadataHash: metaOrt },
	];

	const univerify = await hre.viem.deployContract("Univerify", [genesis, DEFAULT_THRESHOLD]);
	const certificateNft = await hre.viem.deployContract("CertificateNft", [
		univerify.address,
		univerify.address,
	]);
	await univerify.write.setCertificateNft([certificateNft.address], {
		account: deployer.account,
	});

	return {
		univerify,
		certificateNft,
		deployer,
		alice,
		bob,
		charlie,
		applicant,
		stranger,
		student,
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
		it("exposes no owner or owner-admin surface", async function () {
			const { univerify } = await loadFixture(deployWithGenesis);
			const fnNames = (univerify.abi as Abi)
				.filter(
					(item): item is Extract<Abi[number], { type: "function" }> =>
						item.type === "function",
				)
				.map((item) => item.name);
			// Centralised admin surface must be gone.
			expect(fnNames).to.not.include("owner");
			expect(fnNames).to.not.include("transferOwnership");
			expect(fnNames).to.not.include("suspendIssuer");
			expect(fnNames).to.not.include("unsuspendIssuer");

			// And there must be no lingering centralised admin events either.
			const eventNames = (univerify.abi as Abi)
				.filter(
					(item): item is Extract<Abi[number], { type: "event" }> =>
						item.type === "event",
				)
				.map((item) => item.name);
			expect(eventNames).to.not.include("OwnershipTransferred");
			expect(eventNames).to.not.include("IssuerSuspended");
			expect(eventNames).to.not.include("IssuerUnsuspended");
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

		it("seeds activeIssuerCount to genesis length", async function () {
			const { univerify, genesis } = await loadFixture(deployWithGenesis);
			expect(Number(await univerify.read.activeIssuerCount())).to.equal(genesis.length);
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

		it("emits one IssuerActivated per genesis issuer", async function () {
			const { univerify, publicClient, genesis } = await loadFixture(deployWithGenesis);

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

		it("does not change activeIssuerCount on application", async function () {
			const { univerify, applicant, genesis } = await loadFixture(deployWithGenesis);
			await univerify.write.applyAsIssuer(["Applicant University", metaApplicant], {
				account: applicant.account,
			});
			expect(Number(await univerify.read.activeIssuerCount())).to.equal(genesis.length);
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

		it("allows a governance-removed issuer to re-apply and returns them to Pending", async function () {
			// Remove Alice through governance (threshold=2 → Bob proposes, Charlie votes).
			const { univerify, alice, bob, charlie, publicClient } =
				await loadFixture(deployWithGenesis);
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			const proposalId = (await univerify.read.openRemovalProposal([
				alice.account.address,
			])) as bigint;
			await univerify.write.voteForRemoval([proposalId], { account: charlie.account });

			const listLengthBefore = (await univerify.read.issuerCount()) as bigint;
			const epochBefore = (await univerify.read.issuerEpoch([
				alice.account.address,
			])) as number | bigint;

			const reapplyHash = await univerify.write.applyAsIssuer(
				["UDELAR-reborn", metaUdelar],
				{ account: alice.account },
			);

			// Status is back to Pending with a fresh approval counter and the
			// new profile metadata taking over the existing slot.
			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([alice.account.address])) as unknown,
			);
			expect(profile.status).to.equal(STATUS_PENDING);
			expect(profile.approvalCount).to.equal(0);
			expect(profile.name).to.equal("UDELAR-reborn");

			// Epoch must have advanced so prior approvals cannot leak in.
			const epochAfter = (await univerify.read.issuerEpoch([
				alice.account.address,
			])) as number | bigint;
			expect(Number(epochAfter)).to.equal(Number(epochBefore) + 1);

			// Enumeration must not be duplicated — the same slot is reused.
			const listLengthAfter = (await univerify.read.issuerCount()) as bigint;
			expect(listLengthAfter).to.equal(listLengthBefore);

			// Event is re-emitted with the new profile data.
			const receipt = await publicClient.waitForTransactionReceipt({ hash: reapplyHash });
			const applied = parseEventLogs({
				abi: univerify.abi as unknown as Abi,
				eventName: "IssuerApplied",
				logs: receipt.logs as Log[],
			}) as unknown as Array<{ args: ApplyArgs }>;
			expect(applied).to.have.length(1);
			expect(applied[0].args.issuer.toLowerCase()).to.equal(
				alice.account.address.toLowerCase(),
			);
			expect(applied[0].args.name).to.equal("UDELAR-reborn");
		});

		it("resets approvals on re-application: prior approvers can vote again, old approvals don't count", async function () {
			// Alice is removed, then re-applies; the two other genesis issuers
			// (Bob, Charlie) must be able to approve her fresh application even
			// though they had approved her — implicitly, via genesis — before.
			const { univerify, alice, bob, charlie } = await loadFixture(deployWithGenesis);

			// Remove Alice.
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			const proposalId = (await univerify.read.openRemovalProposal([
				alice.account.address,
			])) as bigint;
			await univerify.write.voteForRemoval([proposalId], { account: charlie.account });

			// Re-apply.
			await univerify.write.applyAsIssuer(["UDELAR-reborn", metaUdelar], {
				account: alice.account,
			});

			// hasApproved now reflects the current (new) round for Alice — none
			// of the prior round's approvals carry over.
			expect(
				(await univerify.read.hasApproved([
					alice.account.address,
					bob.account.address,
				])) as boolean,
			).to.equal(false);
			expect(
				(await univerify.read.hasApproved([
					alice.account.address,
					charlie.account.address,
				])) as boolean,
			).to.equal(false);

			// Bob and Charlie can approve again; on the second approval (threshold=2)
			// Alice is promoted back to Active and activeIssuerCount is restored.
			await univerify.write.approveIssuer([alice.account.address], {
				account: bob.account,
			});
			await univerify.write.approveIssuer([alice.account.address], {
				account: charlie.account,
			});

			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([alice.account.address])) as unknown,
			);
			expect(profile.status).to.equal(STATUS_ACTIVE);
			expect(profile.approvalCount).to.equal(2);

			const active = (await univerify.read.activeIssuerCount()) as number | bigint;
			expect(Number(active)).to.equal(3);
		});

		it("supports multiple remove/re-apply cycles with independent approval rounds", async function () {
			const { univerify, alice, bob, charlie } = await loadFixture(deployWithGenesis);

			async function removeAlice() {
				await univerify.write.proposeRemoval([alice.account.address], {
					account: bob.account,
				});
				const id = (await univerify.read.openRemovalProposal([
					alice.account.address,
				])) as bigint;
				await univerify.write.voteForRemoval([id], { account: charlie.account });
			}

			// Round 1: remove → re-apply → re-activate.
			await removeAlice();
			await univerify.write.applyAsIssuer(["UDELAR-r1", metaUdelar], {
				account: alice.account,
			});
			await univerify.write.approveIssuer([alice.account.address], {
				account: bob.account,
			});
			await univerify.write.approveIssuer([alice.account.address], {
				account: charlie.account,
			});

			// Round 2: remove again → re-apply again.
			await removeAlice();
			await univerify.write.applyAsIssuer(["UDELAR-r2", metaUdelar], {
				account: alice.account,
			});
			const epoch = (await univerify.read.issuerEpoch([
				alice.account.address,
			])) as number | bigint;
			expect(Number(epoch)).to.equal(2);

			// New round is a clean slate: no approver has approved yet this round.
			expect(
				(await univerify.read.hasApproved([
					alice.account.address,
					bob.account.address,
				])) as boolean,
			).to.equal(false);
		});

		it("reverts IssuerAlreadyExists when a Removed issuer re-applies while status is Pending again", async function () {
			// After a re-application, the second apply in the same round must
			// still be rejected — epoch-bumping is a one-shot per transition.
			const { univerify, alice, bob, charlie } = await loadFixture(deployWithGenesis);
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			const proposalId = (await univerify.read.openRemovalProposal([
				alice.account.address,
			])) as bigint;
			await univerify.write.voteForRemoval([proposalId], { account: charlie.account });

			await univerify.write.applyAsIssuer(["UDELAR-reborn", metaUdelar], {
				account: alice.account,
			});

			await expectRevert(
				() =>
					univerify.write.applyAsIssuer(["UDELAR-dup", metaUdelar], {
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

			// activeIssuerCount grew by one (from 3 genesis to 4).
			expect(Number(await univerify.read.activeIssuerCount())).to.equal(4);

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

		it("reverts NotActiveIssuer when a governance-removed issuer tries to approve", async function () {
			// Remove Alice by governance (threshold=2 → Bob proposes, Charlie votes).
			const { univerify, alice, bob, charlie, applicant } = await loadFixture(
				deployWithPendingApplicant,
			);
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			const proposalId = (await univerify.read.openRemovalProposal([
				alice.account.address,
			])) as bigint;
			await univerify.write.voteForRemoval([proposalId], { account: charlie.account });

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

		it("preserves historical approval records after the approver is removed", async function () {
			const { univerify, alice, bob, charlie, applicant } = await loadFixture(
				deployWithPendingApplicant,
			);
			await univerify.write.approveIssuer([applicant.account.address], {
				account: alice.account,
			});
			// Remove Alice by governance.
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			const proposalId = (await univerify.read.openRemovalProposal([
				alice.account.address,
			])) as bigint;
			await univerify.write.voteForRemoval([proposalId], { account: charlie.account });

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

	// ── Governance: removal proposals & voting ───────────────────────

	describe("proposeRemoval", function () {
		it("creates a proposal with the proposer's own vote counted", async function () {
			const { univerify, alice, bob, publicClient } = await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			const proposalId = 1n; // first proposal id minted
			expect((await univerify.read.removalProposalCount()) as bigint).to.equal(1n);
			expect(
				(await univerify.read.openRemovalProposal([bob.account.address])) as bigint,
			).to.equal(proposalId);

			const p = readRemovalProposal(
				(await univerify.read.getRemovalProposal([proposalId])) as readonly unknown[],
			);
			expect(getAddress(p.target)).to.equal(getAddress(bob.account.address));
			expect(getAddress(p.proposer)).to.equal(getAddress(alice.account.address));
			expect(p.voteCount).to.equal(1);
			expect(p.executed).to.equal(false);
			expect(p.createdAt > 0n).to.equal(true);

			expect(
				await univerify.read.hasVotedOnRemoval([proposalId, alice.account.address]),
			).to.equal(true);
			expect(
				await univerify.read.hasVotedOnRemoval([proposalId, bob.account.address]),
			).to.equal(false);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const createdLogs = parseLogs<RemovalCreatedArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"RemovalProposalCreated",
			);
			expect(createdLogs).to.have.lengthOf(1);
			expect(createdLogs[0].args.proposalId).to.equal(proposalId);
			expect(getAddress(createdLogs[0].args.target)).to.equal(
				getAddress(bob.account.address),
			);
			expect(getAddress(createdLogs[0].args.proposer)).to.equal(
				getAddress(alice.account.address),
			);

			const voteLogs = parseLogs<RemovalVoteArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"RemovalVoteCast",
			);
			expect(voteLogs).to.have.lengthOf(1);
			expect(voteLogs[0].args.proposalId).to.equal(proposalId);
			expect(getAddress(voteLogs[0].args.voter)).to.equal(
				getAddress(alice.account.address),
			);
			expect(Number(voteLogs[0].args.voteCount)).to.equal(1);
		});

		it("reverts NotActiveIssuer when a non-active account proposes", async function () {
			const { univerify, stranger, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.proposeRemoval([alice.account.address], {
						account: stranger.account,
					}),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when a Pending applicant proposes removal", async function () {
			const { univerify, applicant, alice } = await loadFixture(
				deployWithPendingApplicant,
			);
			await expectRevert(
				() =>
					univerify.write.proposeRemoval([alice.account.address], {
						account: applicant.account,
					}),
				"NotActiveIssuer",
			);
		});

		it("reverts CannotProposeSelfRemoval", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.proposeRemoval([alice.account.address], {
						account: alice.account,
					}),
				"CannotProposeSelfRemoval",
			);
		});

		it("reverts IssuerNotFound when target is unknown", async function () {
			const { univerify, alice, stranger } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.proposeRemoval([stranger.account.address], {
						account: alice.account,
					}),
				"IssuerNotFound",
			);
		});

		it("reverts IssuerNotActive when target is Pending", async function () {
			const { univerify, alice, applicant } = await loadFixture(
				deployWithPendingApplicant,
			);
			await expectRevert(
				() =>
					univerify.write.proposeRemoval([applicant.account.address], {
						account: alice.account,
					}),
				"IssuerNotActive",
			);
		});

		it("reverts RemovalProposalAlreadyOpen on duplicate proposal for the same target", async function () {
			const { univerify, alice, bob, charlie } = await loadFixture(deployWithGenesis);
			await univerify.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			await expectRevert(
				() =>
					univerify.write.proposeRemoval([bob.account.address], {
						account: charlie.account,
					}),
				"RemovalProposalAlreadyOpen",
			);
		});

		it("executes immediately when threshold is 1 (single-genesis federation)", async function () {
			const [, alice, bob, charlie] = await hre.viem.getWalletClients();

			// Federation of 2 where threshold is 1 — a single vote is enough.
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
				{ account: bob.account.address, name: "B", metadataHash: metaUm },
			];
			const u = await hre.viem.deployContract("Univerify", [genesis, 1]);
			// Wire a dummy NFT so the deployment is complete — not needed for this
			// test, but keeps the fixture symmetric with `deployWithGenesis`.
			const nft = await hre.viem.deployContract("CertificateNft", [u.address, u.address]);
			await u.write.setCertificateNft([nft.address], { account: charlie.account });

			const txHash = await u.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			const client = await hre.viem.getPublicClient();
			const receipt = await client.waitForTransactionReceipt({ hash: txHash });

			// IssuerRemoved fired in the same tx.
			const removedLogs = parseLogs<RemovalExecutedArgs>(
				u.abi as Abi,
				receipt.logs,
				"IssuerRemoved",
			);
			expect(removedLogs).to.have.lengthOf(1);
			expect(getAddress(removedLogs[0].args.issuer)).to.equal(
				getAddress(bob.account.address),
			);

			const profile = readIssuerStruct(
				(await u.read.getIssuer([bob.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_REMOVED);
			expect(await u.read.isActiveIssuer([bob.account.address])).to.equal(false);
			expect(Number(await u.read.activeIssuerCount())).to.equal(1);

			// Proposal slot is cleared so a future target can reuse it (not
			// that `bob` can be re-proposed — they're no longer Active — but
			// the invariant is what the frontend relies on).
			expect(
				(await u.read.openRemovalProposal([bob.account.address])) as bigint,
			).to.equal(0n);
		});
	});

	describe("voteForRemoval", function () {
		it("counts a second vote and executes once threshold is reached", async function () {
			const { univerify, alice, bob, charlie, publicClient } =
				await loadFixture(deployWithGenesis);

			await univerify.write.proposeRemoval([charlie.account.address], {
				account: alice.account,
			});
			const proposalId = 1n;

			const txHash = await univerify.write.voteForRemoval([proposalId], {
				account: bob.account,
			});

			const p = readRemovalProposal(
				(await univerify.read.getRemovalProposal([proposalId])) as readonly unknown[],
			);
			expect(p.voteCount).to.equal(DEFAULT_THRESHOLD);
			expect(p.executed).to.equal(true);

			const profile = readIssuerStruct(
				(await univerify.read.getIssuer([charlie.account.address])) as readonly unknown[],
			);
			expect(profile.status).to.equal(STATUS_REMOVED);
			expect(Number(await univerify.read.activeIssuerCount())).to.equal(2);
			expect(
				(await univerify.read.openRemovalProposal([charlie.account.address])) as bigint,
			).to.equal(0n);

			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const voteLogs = parseLogs<RemovalVoteArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"RemovalVoteCast",
			);
			expect(voteLogs).to.have.lengthOf(1);
			expect(Number(voteLogs[0].args.voteCount)).to.equal(DEFAULT_THRESHOLD);

			const removedLogs = parseLogs<RemovalExecutedArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"IssuerRemoved",
			);
			expect(removedLogs).to.have.lengthOf(1);
			expect(removedLogs[0].args.proposalId).to.equal(proposalId);
			expect(getAddress(removedLogs[0].args.issuer)).to.equal(
				getAddress(charlie.account.address),
			);
		});

		it("reverts RemovalProposalNotFound for an unknown proposal id", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.voteForRemoval([999n], {
						account: alice.account,
					}),
				"RemovalProposalNotFound",
			);
		});

		it("reverts NotActiveIssuer when a non-active account tries to vote", async function () {
			const { univerify, alice, bob, stranger } = await loadFixture(deployWithGenesis);
			await univerify.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			await expectRevert(
				() =>
					univerify.write.voteForRemoval([1n], {
						account: stranger.account,
					}),
				"NotActiveIssuer",
			);
		});

		it("reverts AlreadyVotedForRemoval when the proposer votes again", async function () {
			const { univerify, alice, bob } = await loadFixture(deployWithGenesis);
			await univerify.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			await expectRevert(
				() =>
					univerify.write.voteForRemoval([1n], {
						account: alice.account,
					}),
				"AlreadyVotedForRemoval",
			);
		});

		it("reverts CannotVoteOnOwnRemoval when the target tries to vote", async function () {
			// 4-issuer federation (threshold 2) so charlie isn't enough on his
			// own to execute before alice gets a chance to attempt voting.
			const [deployer, alice, bob, charlie, dave] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
				{ account: bob.account.address, name: "B", metadataHash: metaUm },
				{ account: charlie.account.address, name: "C", metadataHash: metaOrt },
				{ account: dave.account.address, name: "D", metadataHash: metaApplicant },
			];
			const u = await hre.viem.deployContract("Univerify", [genesis, 3]);
			const nft = await hre.viem.deployContract("CertificateNft", [u.address, u.address]);
			await u.write.setCertificateNft([nft.address], { account: deployer.account });

			await u.write.proposeRemoval([alice.account.address], { account: bob.account });
			await expectRevert(
				() =>
					u.write.voteForRemoval([1n], {
						account: alice.account,
					}),
				"CannotVoteOnOwnRemoval",
			);
		});

		it("reverts AlreadyVotedForRemoval on duplicate vote from the same voter", async function () {
			// 4-issuer federation with threshold 3 so a second vote doesn't
			// immediately execute and the third voter gets to attempt a
			// duplicate.
			const [deployer, alice, bob, charlie, dave] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
				{ account: bob.account.address, name: "B", metadataHash: metaUm },
				{ account: charlie.account.address, name: "C", metadataHash: metaOrt },
				{ account: dave.account.address, name: "D", metadataHash: metaApplicant },
			];
			const u = await hre.viem.deployContract("Univerify", [genesis, 3]);
			const nft = await hre.viem.deployContract("CertificateNft", [u.address, u.address]);
			await u.write.setCertificateNft([nft.address], { account: deployer.account });

			await u.write.proposeRemoval([dave.account.address], { account: alice.account });
			await u.write.voteForRemoval([1n], { account: bob.account });
			await expectRevert(
				() =>
					u.write.voteForRemoval([1n], {
						account: bob.account,
					}),
				"AlreadyVotedForRemoval",
			);
		});

		it("reverts RemovalProposalAlreadyExecuted after execution", async function () {
			// 4-issuer federation, threshold 2, so we execute and a fourth issuer
			// then tries to pile on a late vote.
			const [deployer, alice, bob, charlie, dave] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
				{ account: bob.account.address, name: "B", metadataHash: metaUm },
				{ account: charlie.account.address, name: "C", metadataHash: metaOrt },
				{ account: dave.account.address, name: "D", metadataHash: metaApplicant },
			];
			const u = await hre.viem.deployContract("Univerify", [genesis, 2]);
			const nft = await hre.viem.deployContract("CertificateNft", [u.address, u.address]);
			await u.write.setCertificateNft([nft.address], { account: deployer.account });

			await u.write.proposeRemoval([dave.account.address], { account: alice.account });
			await u.write.voteForRemoval([1n], { account: bob.account }); // executes
			await expectRevert(
				() =>
					u.write.voteForRemoval([1n], {
						account: charlie.account,
					}),
				"RemovalProposalAlreadyExecuted",
			);
		});

		it("keeps activeIssuerCount consistent after several removals", async function () {
			const { univerify, alice, bob, charlie, genesis } =
				await loadFixture(deployWithGenesis);
			expect(Number(await univerify.read.activeIssuerCount())).to.equal(genesis.length);

			// Remove bob.
			await univerify.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			await univerify.write.voteForRemoval([1n], { account: charlie.account });
			expect(Number(await univerify.read.activeIssuerCount())).to.equal(
				genesis.length - 1,
			);

			// Now only alice + charlie are active. threshold is 2. They can
			// still remove each other by unanimity — alice proposes charlie,
			// charlie can't vote on own removal, but proposer + alice's vote
			// is already 1. We need a second active voter. With only 2 active
			// issuers, removal is possible only if both agree (majority).
			// Here the proposer is already one of the two, so no second
			// voter exists other than the target. Test that the proposal
			// stays open (and can't be voted on because nobody else can
			// contribute).
			await univerify.write.proposeRemoval([charlie.account.address], {
				account: alice.account,
			});
			const p = readRemovalProposal(
				(await univerify.read.getRemovalProposal([2n])) as readonly unknown[],
			);
			expect(p.executed).to.equal(false);
			expect(p.voteCount).to.equal(1);

			// Charlie can't vote on own removal. Stalemate.
			await expectRevert(
				() =>
					univerify.write.voteForRemoval([2n], {
						account: charlie.account,
					}),
				"CannotVoteOnOwnRemoval",
			);
		});
	});

	// ── Certificate issuance ─────────────────────────────────────────

	describe("issueCertificate", function () {
		it("an Active issuer can issue a certificate and it is stored correctly", async function () {
			const { univerify, alice, student, publicClient } =
				await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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

		it("emits CertificateIssued (with student)", async function () {
			const { univerify, alice, student, publicClient } =
				await loadFixture(deployWithGenesis);
			const txHash = await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
				{ account: alice.account },
			);
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
			const logs = parseLogs<CertIssuedArgs>(
				univerify.abi as Abi,
				receipt.logs,
				"CertificateIssued",
			);
			expect(logs).to.have.lengthOf(1);
			expect(logs[0].args.certificateId).to.equal(certificateId);
			expect(getAddress(logs[0].args.issuer)).to.equal(getAddress(alice.account.address));
			expect(getAddress(logs[0].args.student)).to.equal(getAddress(student.account.address));
		});

		it("returns the certificateId", async function () {
			const { univerify, alice, student, publicClient } =
				await loadFixture(deployWithGenesis);
			const { result } = await publicClient.simulateContract({
				address: univerify.address,
				abi: univerify.abi,
				functionName: "issueCertificate",
				args: [certificateId, claimsHash, recipientCommitment, student.account.address],
				account: alice.account,
			});
			expect(result).to.equal(certificateId);
		});

		it("reverts NotActiveIssuer when caller is unknown (None)", async function () {
			const { univerify, stranger, student } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment, student.account.address],
						{ account: stranger.account },
					),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when caller is Pending", async function () {
			const { univerify, applicant, student } =
				await loadFixture(deployWithPendingApplicant);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment, student.account.address],
						{ account: applicant.account },
					),
				"NotActiveIssuer",
			);
		});

		it("reverts NotActiveIssuer when caller has been removed by governance", async function () {
			const { univerify, alice, bob, charlie, student } =
				await loadFixture(deployWithGenesis);
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			await univerify.write.voteForRemoval([1n], { account: charlie.account });
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment, student.account.address],
						{ account: alice.account },
					),
				"NotActiveIssuer",
			);
		});

		it("reverts InvalidCertificateId on zero id", async function () {
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[ZERO_BYTES32, claimsHash, recipientCommitment, student.account.address],
						{ account: alice.account },
					),
				"InvalidCertificateId",
			);
		});

		it("reverts InvalidClaimsHash on zero claims hash", async function () {
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, ZERO_BYTES32, recipientCommitment, student.account.address],
						{ account: alice.account },
					),
				"InvalidClaimsHash",
			);
		});

		it("reverts InvalidRecipientCommitment on zero recipient commitment", async function () {
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, ZERO_BYTES32, student.account.address],
						{ account: alice.account },
					),
				"InvalidRecipientCommitment",
			);
		});

		it("reverts CertificateAlreadyExists on duplicate id", async function () {
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
				{ account: alice.account },
			);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash2, recipientCommitment, student.account.address],
						{ account: alice.account },
					),
				"CertificateAlreadyExists",
			);
		});

		it("reverts InvalidStudentAddress on zero student", async function () {
			const { univerify, alice } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment, ZERO_ADDRESS],
						{ account: alice.account },
					),
				"InvalidStudentAddress",
			);
		});

		it("mints exactly one soulbound NFT to the student wallet", async function () {
			const { univerify, certificateNft, alice, student } =
				await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
				{ account: alice.account },
			);
			const tokenId = (await certificateNft.read.certIdToTokenId([
				certificateId,
			])) as bigint;
			expect(tokenId).to.equal(1n);
			expect(
				getAddress((await certificateNft.read.ownerOf([tokenId])) as Address),
			).to.equal(getAddress(student.account.address));
			expect((await certificateNft.read.balanceOf([student.account.address])) as bigint).to.equal(
				1n,
			);
			expect((await certificateNft.read.tokenIdToCertId([tokenId])) as Hex).to.equal(
				certificateId,
			);
		});
	});

	// ── NFT wiring ───────────────────────────────────────────────────

	describe("setCertificateNft", function () {
		it("reverts NftNotConfigured when issuing before NFT is wired", async function () {
			// Deploy a fresh Univerify without wiring a CertificateNft.
			const [, alice, , , , , student] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: GENESIS_NAMES[0], metadataHash: metaUdelar },
			];
			const univerify = await hre.viem.deployContract("Univerify", [genesis, 1]);
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment, student.account.address],
						{ account: alice.account },
					),
				"NftNotConfigured",
			);
		});

		it("reverts NftAlreadySet on second wire-up", async function () {
			const { univerify, certificateNft, deployer } = await loadFixture(deployWithGenesis);
			await expectRevert(
				() =>
					univerify.write.setCertificateNft([certificateNft.address], {
						account: deployer.account,
					}),
				"NftAlreadySet",
			);
		});

		it("reverts ZeroAddress when wiring the zero address", async function () {
			const [, alice] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
			];
			const univerify = await hre.viem.deployContract("Univerify", [genesis, 1]);
			await expectRevert(
				() =>
					univerify.write.setCertificateNft([ZERO_ADDRESS], {
						account: alice.account,
					}),
				"ZeroAddress",
			);
		});

		it("reverts NftMinterMismatch when wiring an NFT whose minter is a different registry", async function () {
			// Two separate Univerify contracts; wire NFT bound to A into B.
			const [deployer, alice] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
			];
			const uA = await hre.viem.deployContract("Univerify", [genesis, 1]);
			const uB = await hre.viem.deployContract("Univerify", [genesis, 1]);
			const nftForA = await hre.viem.deployContract("CertificateNft", [
				uA.address,
				uA.address,
			]);
			await expectRevert(
				() =>
					uB.write.setCertificateNft([nftForA.address], {
						account: deployer.account,
					}),
				"NftMinterMismatch",
			);
		});

		it("allows any caller to wire the NFT (no privileged configurer)", async function () {
			// Deploy a fresh Univerify, then have a non-genesis wallet do the wiring.
			const [, alice, bob, , , stranger] = await hre.viem.getWalletClients();
			const genesis = [
				{ account: alice.account.address, name: "A", metadataHash: metaUdelar },
				{ account: bob.account.address, name: "B", metadataHash: metaUm },
			];
			const u = await hre.viem.deployContract("Univerify", [genesis, 2]);
			const nft = await hre.viem.deployContract("CertificateNft", [u.address, u.address]);
			// `stranger` is neither a genesis issuer nor the deployer.
			await u.write.setCertificateNft([nft.address], { account: stranger.account });
			expect(getAddress((await u.read.certificateNft()) as Address)).to.equal(
				getAddress(nft.address),
			);
		});
	});

	// ── Certificate revocation ───────────────────────────────────────

	describe("revokeCertificate", function () {
		it("the original Active issuer can revoke and emits CertificateRevoked", async function () {
			const { univerify, alice, student, publicClient } =
				await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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
			const { univerify, alice, bob, student } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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

		it("reverts NotActiveIssuer when the original issuer has been removed by governance", async function () {
			// Documents the intentional design: a governance-removed issuer
			// cannot revoke their own past certificates.
			const { univerify, alice, bob, charlie, student } =
				await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
				{ account: alice.account },
			);
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			await univerify.write.voteForRemoval([1n], { account: charlie.account });
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
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
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

		it("still verifies a certificate issued by an issuer that was later removed", async function () {
			// The contract deliberately does not track issuer status on the
			// certificate itself, so governance changes never invalidate past
			// issuance.
			const { univerify, alice, bob, charlie, student } =
				await loadFixture(deployWithGenesis);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment, student.account.address],
				{ account: alice.account },
			);
			await univerify.write.proposeRemoval([alice.account.address], {
				account: bob.account,
			});
			await univerify.write.voteForRemoval([1n], { account: charlie.account });
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
			const { univerify, alice, bob, charlie, applicant, stranger } = await loadFixture(
				deployWithPendingApplicant,
			);
			expect(await univerify.read.isActiveIssuer([alice.account.address])).to.equal(true);
			expect(await univerify.read.isActiveIssuer([applicant.account.address])).to.equal(
				false,
			);
			expect(await univerify.read.isActiveIssuer([stranger.account.address])).to.equal(false);

			// Remove bob by governance.
			await univerify.write.proposeRemoval([bob.account.address], {
				account: alice.account,
			});
			await univerify.write.voteForRemoval([1n], { account: charlie.account });
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

		it("getRemovalProposal returns a zeroed struct for unknown proposal ids", async function () {
			const { univerify } = await loadFixture(deployWithGenesis);
			const p = readRemovalProposal(
				(await univerify.read.getRemovalProposal([42n])) as readonly unknown[],
			);
			expect(getAddress(p.target)).to.equal(getAddress(ZERO_ADDRESS));
			expect(getAddress(p.proposer)).to.equal(getAddress(ZERO_ADDRESS));
			expect(p.voteCount).to.equal(0);
			expect(p.executed).to.equal(false);
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
			issuanceDate: "2026-03",
		};
		const internalRef = "UDELAR-CS-2026-00142";
		const secret = keccak256(toBytes("holder-secret-entropy"));
		const holderIdentifier = "maria.garcia@udelar.edu";

		it("issues and verifies with buildCredential", async function () {
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);

			const built = buildCredential({
				issuer: alice.account.address,
				internalRef,
				claims: sampleClaims,
				secret,
				holderIdentifier,
			});

			await univerify.write.issueCertificate(
				[built.certificateId, built.claimsHash, built.recipientCommitment, student.account.address],
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
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);

			const built = buildCredential({
				issuer: alice.account.address,
				internalRef,
				claims: sampleClaims,
				secret,
				holderIdentifier,
			});

			await univerify.write.issueCertificate(
				[built.certificateId, built.claimsHash, built.recipientCommitment, student.account.address],
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

		// ── Schema v2 normalization ──────────────────────────────────

		it("normalizes casing and whitespace before hashing", function () {
			const h1 = computeClaimsHash(sampleClaims);
			const h2 = computeClaimsHash({
				degreeTitle: "  bachelor   of  computer SCIENCE ",
				holderName: "MARIA   garcia",
				institutionName: " udelar ",
				issuanceDate: "2026-03",
			});
			expect(h1).to.equal(h2);
		});

		it("accepts legacy YYYY-MM-DD and canonicalizes it to YYYY-MM", function () {
			const fromMonth = computeClaimsHash(sampleClaims);
			const fromIsoDate = computeClaimsHash({
				...sampleClaims,
				issuanceDate: "2026-03-15",
			});
			expect(fromIsoDate).to.equal(fromMonth);
		});

		it("rejects an invalid issuanceDate", function () {
			expect(() =>
				computeClaimsHash({ ...sampleClaims, issuanceDate: "March 2026" }),
			).to.throw(/Invalid issuanceDate/);
			expect(() =>
				computeClaimsHash({ ...sampleClaims, issuanceDate: "2026-13" }),
			).to.throw(/Invalid issuanceDate/);
			expect(() =>
				computeClaimsHash({ ...sampleClaims, issuanceDate: "2026/03" }),
			).to.throw(/Invalid issuanceDate/);
		});

		it("produces different hashes for different issuance months", function () {
			const march = computeClaimsHash({ ...sampleClaims, issuanceDate: "2026-03" });
			const april = computeClaimsHash({ ...sampleClaims, issuanceDate: "2026-04" });
			expect(march).to.not.equal(april);
		});

		it("verifies on-chain when the verifier types lower-cased claims", async function () {
			const { univerify, alice, student } = await loadFixture(deployWithGenesis);

			const built = buildCredential({
				issuer: alice.account.address,
				internalRef,
				claims: sampleClaims,
				secret,
				holderIdentifier,
			});

			await univerify.write.issueCertificate(
				[built.certificateId, built.claimsHash, built.recipientCommitment, student.account.address],
				{ account: alice.account },
			);

			// Verifier re-types the claims in a totally different casing /
			// whitespace shape — Schema v2 normalization makes this match.
			const verifierHash = computeClaimsHash({
				degreeTitle: "bachelor of computer science",
				holderName: "  maria   garcia ",
				institutionName: "udelar",
				issuanceDate: "2026-03",
			});

			const [, , hashMatch] = (await univerify.read.verifyCertificate([
				built.certificateId,
				verifierHash,
			])) as readonly [boolean, Address, boolean, boolean, bigint];

			expect(hashMatch).to.equal(true);
		});
	});
});
