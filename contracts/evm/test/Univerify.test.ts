import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { Address, Hex } from "viem";
import { getAddress, keccak256, parseEventLogs, toBytes } from "viem";
import {
	computeClaimsHash,
	deriveCertificateId,
	computeRecipientCommitment,
	buildCredential,
	type CredentialClaims,
} from "../src/credential";

/** Hardhat-viem returns public struct getters as tuples (ABI component order). */
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

function readIssuerProfileTuple(raw: readonly unknown[]) {
	const [account, status, metadataHash] = raw;
	return {
		account: account as Address,
		status: Number(status),
		metadataHash: metadataHash as Hex,
	};
}

/** Asserts a viem contract write reverted with a Solidity custom error name. */
function expectCustomError(err: unknown, errorName: string) {
	const parts: string[] = [];
	let cur: unknown = err;
	let depth = 0;
	while (cur !== undefined && cur !== null && depth < 12) {
		if (cur instanceof Error) {
			parts.push(cur.message, cur.name);
			const any = cur as { details?: string; shortMessage?: string };
			if (any.details) parts.push(any.details);
			if (any.shortMessage) parts.push(any.shortMessage);
			cur = cur.cause;
		} else {
			parts.push(String(cur));
			break;
		}
		depth++;
	}
	const joined = parts.join("\n");
	expect(joined, `expected revert containing ${errorName}`).to.include(errorName);
}

describe("Univerify", function () {
	const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

	const certificateId = keccak256(toBytes("cert-001"));
	const certificateId2 = keccak256(toBytes("cert-002"));
	const claimsHash = keccak256(toBytes("canonical-claims-json"));
	const claimsHash2 = keccak256(toBytes("canonical-claims-json-2"));
	const recipientCommitment = keccak256(toBytes("recipient-secret-commitment"));
	const issuerMetadataHash = keccak256(toBytes("issuer-metadata"));

	const ISSUER_ACTIVE = 0;
	const ISSUER_SUSPENDED = 1;

	async function deployFixture() {
		const [owner, issuer, other] = await hre.viem.getWalletClients();
		const univerify = await hre.viem.deployContract("Univerify");
		const publicClient = await hre.viem.getPublicClient();
		return { univerify, owner, issuer, other, publicClient };
	}

	async function deployWithRegisteredIssuer() {
		const ctx = await deployFixture();
		const { univerify, owner, issuer } = ctx;
		await univerify.write.registerIssuer([issuer.account.address, issuerMetadataHash], {
			account: owner.account,
		});
		return ctx;
	}

	// ── Deployment ──────────────────────────────────────────────────────

	describe("Deployment", function () {
		it("should set deployer as owner", async function () {
			const { univerify, owner } = await loadFixture(deployFixture);
			expect(getAddress(await univerify.read.owner())).to.equal(
				getAddress(owner.account.address),
			);
		});
	});

	// ── Issuer Management ───────────────────────────────────────────────

	describe("Issuer Management", function () {
		describe("registerIssuer", function () {
			it("should register a valid issuer", async function () {
				const { univerify, owner, issuer } = await loadFixture(deployFixture);
				await univerify.write.registerIssuer(
					[issuer.account.address, issuerMetadataHash],
					{ account: owner.account },
				);
				expect(
					await univerify.read.authorizedIssuers([issuer.account.address]),
				).to.equal(true);
				const profile = readIssuerProfileTuple(
					(await univerify.read.issuerProfiles([
						issuer.account.address,
					])) as readonly unknown[],
				);
				expect(getAddress(profile.account)).to.equal(
					getAddress(issuer.account.address),
				);
				expect(profile.status).to.equal(ISSUER_ACTIVE);
				expect(profile.metadataHash).to.equal(issuerMetadataHash);
			});

			it("should revert if issuer is zero address", async function () {
				const { univerify, owner } = await loadFixture(deployFixture);
				try {
					await univerify.write.registerIssuer(
						[
							"0x0000000000000000000000000000000000000000",
							issuerMetadataHash,
						],
						{ account: owner.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidIssuerAddress");
				}
			});

			it("should revert if issuer already registered", async function () {
				const { univerify, owner, issuer } = await loadFixture(deployFixture);
				await univerify.write.registerIssuer(
					[issuer.account.address, issuerMetadataHash],
					{ account: owner.account },
				);
				try {
					await univerify.write.registerIssuer(
						[issuer.account.address, issuerMetadataHash],
						{ account: owner.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "IssuerAlreadyRegistered");
				}
			});

			it("should emit IssuerRegistered event", async function () {
				const { univerify, owner, issuer, publicClient } =
					await loadFixture(deployFixture);
				const txHash = await univerify.write.registerIssuer(
					[issuer.account.address, issuerMetadataHash],
					{ account: owner.account },
				);
				const receipt = await publicClient.waitForTransactionReceipt({
					hash: txHash,
				});
				const logs = parseEventLogs({
					abi: univerify.abi,
					logs: receipt.logs,
					eventName: "IssuerRegistered",
				});
				expect(logs).to.have.lengthOf(1);
				expect(getAddress(logs[0].args.issuer!)).to.equal(
					getAddress(issuer.account.address),
				);
			});
		});

		describe("setIssuerStatus", function () {
			it("should activate/deactivate issuer", async function () {
				const { univerify, owner, issuer } = await loadFixture(deployFixture);
				await univerify.write.registerIssuer(
					[issuer.account.address, issuerMetadataHash],
					{ account: owner.account },
				);

				await univerify.write.setIssuerStatus([issuer.account.address, false], {
					account: owner.account,
				});
				expect(
					await univerify.read.authorizedIssuers([issuer.account.address]),
				).to.equal(false);
				let profile = readIssuerProfileTuple(
					(await univerify.read.issuerProfiles([
						issuer.account.address,
					])) as readonly unknown[],
				);
				expect(profile.status).to.equal(ISSUER_SUSPENDED);

				await univerify.write.setIssuerStatus([issuer.account.address, true], {
					account: owner.account,
				});
				expect(
					await univerify.read.authorizedIssuers([issuer.account.address]),
				).to.equal(true);
				profile = readIssuerProfileTuple(
					(await univerify.read.issuerProfiles([
						issuer.account.address,
					])) as readonly unknown[],
				);
				expect(profile.status).to.equal(ISSUER_ACTIVE);
			});

			it("should revert if issuer does not exist", async function () {
				const { univerify, owner, other } = await loadFixture(deployFixture);
				try {
					await univerify.write.setIssuerStatus([other.account.address, true], {
						account: owner.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "IssuerNotFound");
				}
			});
		});
	});

	// ── Certificate Issuance ────────────────────────────────────────────

	describe("Certificate Issuance", function () {
		describe("issueCertificate", function () {
			it("should issue a valid certificate", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				const cert = readCertificateTuple(
					(await univerify.read.certificates([
						certificateId,
					])) as readonly unknown[],
				);
				expect(getAddress(cert.issuer)).to.equal(
					getAddress(issuer.account.address),
				);
				expect(cert.claimsHash).to.equal(claimsHash);
				expect(cert.recipientCommitment).to.equal(recipientCommitment);
				expect(cert.revoked).to.equal(false);
			});

			it("should store correct data with block timestamp", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				const txHash = await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				const receipt = await publicClient.waitForTransactionReceipt({
					hash: txHash,
				});
				const block = await publicClient.getBlock({
					blockNumber: receipt.blockNumber,
				});

				const cert = readCertificateTuple(
					(await univerify.read.certificates([
						certificateId,
					])) as readonly unknown[],
				);
				expect(getAddress(cert.issuer)).to.equal(
					getAddress(issuer.account.address),
				);
				expect(cert.claimsHash).to.equal(claimsHash);
				expect(cert.recipientCommitment).to.equal(recipientCommitment);
				expect(cert.issuedAt).to.equal(block.timestamp);
				expect(cert.revoked).to.equal(false);
			});

			it("should emit CertificateIssued event", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				const txHash = await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				const receipt = await publicClient.waitForTransactionReceipt({
					hash: txHash,
				});
				const logs = parseEventLogs({
					abi: univerify.abi,
					logs: receipt.logs,
					eventName: "CertificateIssued",
				});
				expect(logs).to.have.lengthOf(1);
				expect(logs[0].args.certificateId).to.equal(certificateId);
				expect(getAddress(logs[0].args.issuer!)).to.equal(
					getAddress(issuer.account.address),
				);
			});

			it("should return the certificateId", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				const result = await publicClient.simulateContract({
					address: univerify.address,
					abi: univerify.abi,
					functionName: "issueCertificate",
					args: [certificateId, claimsHash, recipientCommitment],
					account: issuer.account,
				});
				expect(result.result).to.equal(certificateId);
			});
		});

		describe("failure cases", function () {
			it("should revert if not authorized issuer", async function () {
				const { univerify, other } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				try {
					await univerify.write.issueCertificate(
						[certificateId, claimsHash, recipientCommitment],
						{ account: other.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "UnauthorizedIssuer");
				}
			});

			it("should revert if certificateId is zero", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				try {
					await univerify.write.issueCertificate(
						[ZERO_BYTES32, claimsHash, recipientCommitment],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidCertificateId");
				}
			});

			it("should revert if claimsHash is zero", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				try {
					await univerify.write.issueCertificate(
						[certificateId, ZERO_BYTES32, recipientCommitment],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidClaimsHash");
				}
			});

			it("should revert if recipientCommitment is zero", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				try {
					await univerify.write.issueCertificate(
						[certificateId, claimsHash, ZERO_BYTES32],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidRecipientCommitment");
				}
			});

			it("should revert if certificate already exists", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				try {
					await univerify.write.issueCertificate(
						[certificateId, claimsHash2, recipientCommitment],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateAlreadyExists");
				}
			});
		});
	});

	// ── Verification ────────────────────────────────────────────────────

	describe("Verification", function () {
		it("should return exists=false for unknown certificateId", async function () {
			const { univerify } = await loadFixture(deployWithRegisteredIssuer);
			const [exists, issuer, hashMatch, revoked, issuedAt] =
				(await univerify.read.verifyCertificate([
					certificateId,
					claimsHash,
				])) as readonly [boolean, Address, boolean, boolean, bigint];
			expect(exists).to.equal(false);
			expect(issuer).to.equal("0x0000000000000000000000000000000000000000");
			expect(hashMatch).to.equal(false);
			expect(revoked).to.equal(false);
			expect(issuedAt).to.equal(0n);
		});

		it("should return hashMatch=true when claimsHash matches", async function () {
			const { univerify, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: issuer.account },
			);
			const [exists, certIssuer, hashMatch, revoked] =
				(await univerify.read.verifyCertificate([
					certificateId,
					claimsHash,
				])) as readonly [boolean, Address, boolean, boolean, bigint];
			expect(exists).to.equal(true);
			expect(getAddress(certIssuer)).to.equal(
				getAddress(issuer.account.address),
			);
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(false);
		});

		it("should return hashMatch=false when claimsHash does not match", async function () {
			const { univerify, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: issuer.account },
			);
			const wrongHash = keccak256(toBytes("tampered-claims"));
			const [exists, , hashMatch] = (await univerify.read.verifyCertificate([
				certificateId,
				wrongHash,
			])) as readonly [boolean, Address, boolean, boolean, bigint];
			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(false);
		});

		it("should return revoked=true after revocation", async function () {
			const { univerify, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: issuer.account },
			);
			await univerify.write.revokeCertificate([certificateId], {
				account: issuer.account,
			});
			const [exists, , hashMatch, revoked] =
				(await univerify.read.verifyCertificate([
					certificateId,
					claimsHash,
				])) as readonly [boolean, Address, boolean, boolean, bigint];
			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(true);
		});

		it("should retrieve certificate by certificateId via public mapping", async function () {
			const { univerify, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);
			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: issuer.account },
			);
			const cert = readCertificateTuple(
				(await univerify.read.certificates([
					certificateId,
				])) as readonly unknown[],
			);
			expect(getAddress(cert.issuer)).to.equal(
				getAddress(issuer.account.address),
			);
			expect(cert.claimsHash).to.equal(claimsHash);
			expect(cert.revoked).to.equal(false);
		});
	});

	// ── Revocation ──────────────────────────────────────────────────────

	describe("Revocation", function () {
		describe("revokeCertificate", function () {
			it("should allow issuer to revoke certificate", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				await univerify.write.revokeCertificate([certificateId], {
					account: issuer.account,
				});
				const cert = readCertificateTuple(
					(await univerify.read.certificates([
						certificateId,
					])) as readonly unknown[],
				);
				expect(cert.revoked).to.equal(true);
			});

			it("should emit CertificateRevoked event", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				const txHash = await univerify.write.revokeCertificate(
					[certificateId],
					{ account: issuer.account },
				);
				const receipt = await publicClient.waitForTransactionReceipt({
					hash: txHash,
				});
				const logs = parseEventLogs({
					abi: univerify.abi,
					logs: receipt.logs,
					eventName: "CertificateRevoked",
				});
				expect(logs).to.have.lengthOf(1);
				expect(logs[0].args.certificateId).to.equal(certificateId);
				expect(getAddress(logs[0].args.issuer!)).to.equal(
					getAddress(issuer.account.address),
				);
			});
		});

		describe("failure cases", function () {
			it("should revert if certificate does not exist", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				try {
					await univerify.write.revokeCertificate([certificateId], {
						account: issuer.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateNotFound");
				}
			});

			it("should revert if already revoked", async function () {
				const { univerify, issuer } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				await univerify.write.revokeCertificate([certificateId], {
					account: issuer.account,
				});
				try {
					await univerify.write.revokeCertificate([certificateId], {
						account: issuer.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateAlreadyRevoked");
				}
			});

			it("should revert if caller is not the original issuer", async function () {
				const { univerify, issuer, other, owner } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.registerIssuer(
					[other.account.address, issuerMetadataHash],
					{ account: owner.account },
				);
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				try {
					await univerify.write.revokeCertificate([certificateId], {
						account: other.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "NotCertificateIssuer");
				}
			});
		});
	});

	// ── Access Control ──────────────────────────────────────────────────

	describe("Access Control", function () {
		it("only owner can register issuer", async function () {
			const { univerify, issuer, other } = await loadFixture(deployFixture);
			try {
				await univerify.write.registerIssuer(
					[other.account.address, issuerMetadataHash],
					{ account: issuer.account },
				);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "NotOwner");
			}
		});

		it("only owner can change issuer status", async function () {
			const { univerify, issuer, owner } = await loadFixture(deployFixture);
			await univerify.write.registerIssuer(
				[issuer.account.address, issuerMetadataHash],
				{ account: owner.account },
			);
			try {
				await univerify.write.setIssuerStatus(
					[issuer.account.address, false],
					{ account: issuer.account },
				);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "NotOwner");
			}
		});

		it("only authorized issuers can issue certificates", async function () {
			const { univerify, other } = await loadFixture(deployFixture);
			try {
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: other.account },
				);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "UnauthorizedIssuer");
			}
		});

		it("suspended issuer cannot issue certificates", async function () {
			const { univerify, owner, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);
			await univerify.write.setIssuerStatus([issuer.account.address, false], {
				account: owner.account,
			});
			try {
				await univerify.write.issueCertificate(
					[certificateId, claimsHash, recipientCommitment],
					{ account: issuer.account },
				);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "UnauthorizedIssuer");
			}
		});
	});

	// ── Privacy: No Public Enumeration ──────────────────────────────────

	describe("Privacy", function () {
		it("should not expose any enumeration or listing functions", async function () {
			const { univerify } = await loadFixture(deployFixture);
			const abi = univerify.abi;
			const fnNames = abi
				.filter((item: { type: string }) => item.type === "function")
				.map((item: { name: string }) => item.name);

			expect(fnNames).to.not.include("getClaimCount");
			expect(fnNames).to.not.include("getClaimHashAtIndex");
			expect(fnNames).to.not.include("getCertificatesByStudent");
			expect(fnNames).to.not.include("getAllCertificates");
		});
	});

	// ── End-to-End: Canonical Hashing ───────────────────────────────────

	describe("End-to-End with canonical credential hashing", function () {
		const sampleClaims: CredentialClaims = {
			degreeTitle: "Bachelor of Computer Science",
			holderName: "Maria Garcia",
			institutionName: "Universidad de Buenos Aires",
			issuanceDate: "2026-03-15",
		};
		const internalRef = "UBA-CS-2026-00142";
		const secret = keccak256(toBytes("holder-secret-entropy"));
		const holderIdentifier = "maria.garcia@uba.edu";

		it("should issue and verify using buildCredential helper", async function () {
			const { univerify, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);

			const { certificateId, claimsHash, recipientCommitment } =
				buildCredential({
					issuer: issuer.account.address,
					internalRef,
					claims: sampleClaims,
					secret,
					holderIdentifier,
				});

			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: issuer.account },
			);

			const [exists, certIssuer, hashMatch, revoked, issuedAt] =
				(await univerify.read.verifyCertificate([
					certificateId,
					claimsHash,
				])) as readonly [boolean, Address, boolean, boolean, bigint];

			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(true);
			expect(revoked).to.equal(false);
			expect(getAddress(certIssuer)).to.equal(
				getAddress(issuer.account.address),
			);
			expect(issuedAt > 0n).to.equal(true);
		});

		it("should detect tampered claims via hash mismatch", async function () {
			const { univerify, issuer } = await loadFixture(
				deployWithRegisteredIssuer,
			);

			const { certificateId, claimsHash, recipientCommitment } =
				buildCredential({
					issuer: issuer.account.address,
					internalRef,
					claims: sampleClaims,
					secret,
					holderIdentifier,
				});

			await univerify.write.issueCertificate(
				[certificateId, claimsHash, recipientCommitment],
				{ account: issuer.account },
			);

			const tamperedHash = computeClaimsHash({
				...sampleClaims,
				degreeTitle: "Master of Computer Science",
			});

			const [exists, , hashMatch] =
				(await univerify.read.verifyCertificate([
					certificateId,
					tamperedHash,
				])) as readonly [boolean, Address, boolean, boolean, bigint];

			expect(exists).to.equal(true);
			expect(hashMatch).to.equal(false);
		});

		it("should produce deterministic hashes for identical claims", function () {
			const hash1 = computeClaimsHash(sampleClaims);
			const hash2 = computeClaimsHash({ ...sampleClaims });
			expect(hash1).to.equal(hash2);
		});

		it("should produce different hashes for different claims", function () {
			const hash1 = computeClaimsHash(sampleClaims);
			const hash2 = computeClaimsHash({
				...sampleClaims,
				holderName: "Juan Perez",
			});
			expect(hash1).to.not.equal(hash2);
		});

		it("should produce different certificateIds for different refs", function () {
			const addr = "0x0000000000000000000000000000000000000001" as Hex;
			const id1 = deriveCertificateId(addr, "REF-001");
			const id2 = deriveCertificateId(addr, "REF-002");
			expect(id1).to.not.equal(id2);
		});

		it("should produce different commitments for different holders", function () {
			const c1 = computeRecipientCommitment(secret, "alice@uni.edu");
			const c2 = computeRecipientCommitment(secret, "bob@uni.edu");
			expect(c1).to.not.equal(c2);
		});
	});
});
