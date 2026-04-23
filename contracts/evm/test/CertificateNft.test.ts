import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { Abi, Address, Hex, Log } from "viem";
import { getAddress, keccak256, parseEventLogs, toBytes } from "viem";

const ZERO_BYTES32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

const claimsHash = keccak256(toBytes("canonical-claims-json"));
const certificateId = keccak256(toBytes("cert-001"));
const certificateId2 = keccak256(toBytes("cert-002"));
const meta = keccak256(toBytes("meta"));

// ── Revert helpers (kept self-contained — no shared util module) ────

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

async function expectRevert(fn: () => Promise<unknown>, errorName: string) {
	try {
		await fn();
	} catch (e: unknown) {
		expectCustomError(e, errorName);
		return;
	}
	throw new Error(`Expected revert with ${errorName} but call succeeded`);
}

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

type MintArgs = { tokenId: bigint; certificateId: Hex; to: Address };

// ── Fixture ──────────────────────────────────────────────────────────
//
// Wires the same way the deploy script will: deploy Univerify, deploy
// CertificateNft pointing at it, then `setCertificateNft`. The first
// genesis issuer (Alice) is Active and used to drive issuance.

async function deployWired() {
	// The first wallet client acts as the deployer — Univerify no longer has
	// a privileged owner, so this account only signs the deployment and
	// (permissionlessly) wires the NFT. It has no lingering on-chain authority.
	const [deployer, alice, bob, student, other] = await hre.viem.getWalletClients();
	const publicClient = await hre.viem.getPublicClient();

	const genesis = [
		{ account: alice.account.address, name: "UDELAR", metadataHash: meta },
	];
	const univerify = await hre.viem.deployContract("Univerify", [genesis]);
	const certificateNft = await hre.viem.deployContract("CertificateNft", [
		univerify.address,
		univerify.address,
	]);
	await univerify.write.setCertificateNft([certificateNft.address], {
		account: deployer.account,
	});

	return { deployer, alice, bob, student, other, publicClient, univerify, certificateNft };
}

// ── Suite ────────────────────────────────────────────────────────────

describe("CertificateNft", function () {
	describe("Metadata & wiring", function () {
		it("exposes the configured minter and registry", async function () {
			const { certificateNft, univerify } = await loadFixture(deployWired);
			expect(getAddress((await certificateNft.read.minter()) as Address)).to.equal(
				getAddress(univerify.address),
			);
			expect(getAddress((await certificateNft.read.registry()) as Address)).to.equal(
				getAddress(univerify.address),
			);
		});

		it("uses the expected name and symbol", async function () {
			const { certificateNft } = await loadFixture(deployWired);
			expect(await certificateNft.read.name()).to.equal("Univerify Certificate");
			expect(await certificateNft.read.symbol()).to.equal("UVC");
		});

		it("supports the ERC721 and ERC721Enumerable interface ids", async function () {
			const { certificateNft } = await loadFixture(deployWired);
			// IERC721 = 0x80ac58cd, IERC721Enumerable = 0x780e9d63
			expect(await certificateNft.read.supportsInterface(["0x80ac58cd"])).to.equal(true);
			expect(await certificateNft.read.supportsInterface(["0x780e9d63"])).to.equal(true);
		});
	});

	describe("mintFor", function () {
		it("mints sequentially starting at tokenId 1 and links id ↔ certId", async function () {
			const { univerify, certificateNft, alice, student, publicClient } =
				await loadFixture(deployWired);

			const txHash = await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

			const tokenId = (await certificateNft.read.certIdToTokenId([
				certificateId,
			])) as bigint;
			expect(tokenId).to.equal(1n);
			expect((await certificateNft.read.tokenIdToCertId([tokenId])) as Hex).to.equal(
				certificateId,
			);
			expect(
				getAddress((await certificateNft.read.ownerOf([tokenId])) as Address),
			).to.equal(getAddress(student.account.address));

			const logs = parseLogs<MintArgs>(
				certificateNft.abi as Abi,
				receipt.logs,
				"CertificateMinted",
			);
			expect(logs).to.have.lengthOf(1);
			expect(logs[0].args.tokenId).to.equal(1n);
			expect(logs[0].args.certificateId).to.equal(certificateId);
			expect(getAddress(logs[0].args.to)).to.equal(getAddress(student.account.address));
		});

		it("reverts NotMinter when called directly (not via Univerify)", async function () {
			const { certificateNft, alice, student } = await loadFixture(deployWired);
			await expectRevert(
				() =>
					certificateNft.write.mintFor([student.account.address, certificateId], {
						account: alice.account,
					}),
				"NotMinter",
			);
		});

		it("reverts AlreadyMinted (via duplicate issuance) — surfaces as CertificateAlreadyExists at the registry", async function () {
			const { univerify, alice, student } = await loadFixture(deployWired);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			// The registry guards duplicates first, so re-issuing the same id reverts
			// with CertificateAlreadyExists. The NFT-side AlreadyMinted is exercised
			// only if the registry guard is somehow bypassed (defense-in-depth).
			await expectRevert(
				() =>
					univerify.write.issueCertificate(
						[certificateId, claimsHash, student.account.address],
						{ account: alice.account },
					),
				"CertificateAlreadyExists",
			);
		});
	});

	describe("Soulbound enforcement", function () {
		it("transferFrom reverts SoulboundNonTransferable", async function () {
			const { univerify, certificateNft, alice, student, other } =
				await loadFixture(deployWired);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			await expectRevert(
				() =>
					certificateNft.write.transferFrom(
						[student.account.address, other.account.address, 1n],
						{ account: student.account },
					),
				"SoulboundNonTransferable",
			);
		});

		it("safeTransferFrom reverts SoulboundNonTransferable", async function () {
			const { univerify, certificateNft, alice, student, other } =
				await loadFixture(deployWired);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			await expectRevert(
				() =>
					(certificateNft.write as unknown as Record<string, (args: unknown[], opts: { account: typeof student.account }) => Promise<unknown>>)[
						"safeTransferFrom"
					](
						[student.account.address, other.account.address, 1n],
						{ account: student.account },
					),
				"SoulboundNonTransferable",
			);
		});

		it("approve reverts SoulboundNoApprovals", async function () {
			const { univerify, certificateNft, alice, student, other } =
				await loadFixture(deployWired);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			await expectRevert(
				() =>
					certificateNft.write.approve([other.account.address, 1n], {
						account: student.account,
					}),
				"SoulboundNoApprovals",
			);
		});

		it("setApprovalForAll reverts SoulboundNoApprovals", async function () {
			const { certificateNft, student, other } = await loadFixture(deployWired);
			await expectRevert(
				() =>
					certificateNft.write.setApprovalForAll([other.account.address, true], {
						account: student.account,
					}),
				"SoulboundNoApprovals",
			);
		});
	});

	describe("isRevoked mirrors the registry", function () {
		it("returns false before revocation, true after", async function () {
			const { univerify, certificateNft, alice, student } =
				await loadFixture(deployWired);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			const tokenId = (await certificateNft.read.certIdToTokenId([
				certificateId,
			])) as bigint;
			expect(await certificateNft.read.isRevoked([tokenId])).to.equal(false);

			await univerify.write.revokeCertificate([certificateId], { account: alice.account });
			expect(await certificateNft.read.isRevoked([tokenId])).to.equal(true);
		});

		it("returns false for an unknown tokenId rather than reverting", async function () {
			const { certificateNft } = await loadFixture(deployWired);
			expect(await certificateNft.read.isRevoked([999n])).to.equal(false);
		});

		it("certIdToTokenId returns 0 for a non-existent certificate", async function () {
			const { certificateNft } = await loadFixture(deployWired);
			expect(
				(await certificateNft.read.certIdToTokenId([ZERO_BYTES32])) as bigint,
			).to.equal(0n);
		});
	});

	describe("Enumeration", function () {
		it("balanceOf and tokenOfOwnerByIndex enumerate the student's tokens", async function () {
			const { univerify, certificateNft, alice, student } =
				await loadFixture(deployWired);

			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			await univerify.write.issueCertificate(
				[certificateId2, claimsHash, student.account.address],
				{ account: alice.account },
			);

			expect(
				(await certificateNft.read.balanceOf([student.account.address])) as bigint,
			).to.equal(2n);

			const t0 = (await certificateNft.read.tokenOfOwnerByIndex([
				student.account.address,
				0n,
			])) as bigint;
			const t1 = (await certificateNft.read.tokenOfOwnerByIndex([
				student.account.address,
				1n,
			])) as bigint;
			expect(t0).to.equal(1n);
			expect(t1).to.equal(2n);

			expect((await certificateNft.read.tokenIdToCertId([t0])) as Hex).to.equal(
				certificateId,
			);
			expect((await certificateNft.read.tokenIdToCertId([t1])) as Hex).to.equal(
				certificateId2,
			);
		});

		it("totalSupply tracks the number of mints", async function () {
			const { univerify, certificateNft, alice, student } =
				await loadFixture(deployWired);
			expect((await certificateNft.read.totalSupply()) as bigint).to.equal(0n);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, student.account.address],
				{ account: alice.account },
			);
			expect((await certificateNft.read.totalSupply()) as bigint).to.equal(1n);
		});
	});

	describe("Constructor guards", function () {
		it("reverts when minter or registry is the zero address", async function () {
			await expectRevert(
				() => hre.viem.deployContract("CertificateNft", [ZERO_ADDRESS, ZERO_ADDRESS]),
				"InvalidStudent",
			);
		});
	});
});
