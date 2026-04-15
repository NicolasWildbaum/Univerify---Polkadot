import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import type { Address, Hex } from "viem";
import { getAddress, keccak256, parseEventLogs, toBytes } from "viem";

/** Hardhat-viem returns public struct getters as tuples (ABI component order). */
function readCertificateTuple(raw: readonly unknown[]) {
	const [
		issuer,
		studentIdentifierHash,
		documentHash,
		certificateType,
		issuedOn,
		metadataHash,
		fileReference,
		status,
		issuedAt,
		revokedAt,
		revocationReasonHash,
	] = raw;
	return {
		issuer: issuer as Address,
		studentIdentifierHash: studentIdentifierHash as Hex,
		documentHash: documentHash as Hex,
		certificateType: certificateType as string,
		issuedOn: issuedOn as bigint,
		metadataHash: metadataHash as Hex,
		fileReference: fileReference as string,
		status: Number(status),
		issuedAt: issuedAt as bigint,
		revokedAt: revokedAt as bigint,
		revocationReasonHash: revocationReasonHash as Hex,
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

/** Asserts a viem contract write reverted with a Solidity custom error name in the message chain. */
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
	const studentIdentifierHash = keccak256(toBytes("student-identifier"));
	const documentHash = keccak256(toBytes("certificate-pdf"));
	const documentHash2 = keccak256(toBytes("certificate-pdf-2"));
	const metadataHash = keccak256(toBytes("certificate-metadata"));
	const issuerMetadataHash = keccak256(toBytes("issuer-metadata"));
	const revocationReasonHash = keccak256(toBytes("reason"));
	const certificateType = "Bachelor of Science";

	/** CertificateStatus: Active = 0, Revoked = 1 */
	const STATUS_ACTIVE = 0;
	const STATUS_REVOKED = 1;

	/** IssuerStatus: Active = 0, Suspended = 1 */
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

	describe("Deployment", function () {
		it("should set deployer as owner", async function () {
			const { univerify, owner } = await loadFixture(deployFixture);
			expect(getAddress(await univerify.read.owner())).to.equal(
				getAddress(owner.account.address),
			);
		});
	});

	describe("Issuer Management", function () {
		describe("registerIssuer", function () {
			it("should register a valid issuer", async function () {
				const { univerify, owner, issuer } = await loadFixture(deployFixture);
				await univerify.write.registerIssuer([issuer.account.address, issuerMetadataHash], {
					account: owner.account,
				});
				expect(await univerify.read.authorizedIssuers([issuer.account.address])).to.equal(
					true,
				);
				const profile = readIssuerProfileTuple(
					(await univerify.read.issuerProfiles([
						issuer.account.address,
					])) as readonly unknown[],
				);
				expect(getAddress(profile.account)).to.equal(getAddress(issuer.account.address));
				expect(profile.status).to.equal(ISSUER_ACTIVE);
				expect(profile.metadataHash).to.equal(issuerMetadataHash);
			});

			it("should revert if issuer is zero address", async function () {
				const { univerify, owner } = await loadFixture(deployFixture);
				try {
					await univerify.write.registerIssuer(
						["0x0000000000000000000000000000000000000000", issuerMetadataHash],
						{ account: owner.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidIssuerAddress");
				}
			});

			it("should revert if issuer already registered", async function () {
				const { univerify, owner, issuer } = await loadFixture(deployFixture);
				await univerify.write.registerIssuer([issuer.account.address, issuerMetadataHash], {
					account: owner.account,
				});
				try {
					await univerify.write.registerIssuer(
						[issuer.account.address, issuerMetadataHash],
						{
							account: owner.account,
						},
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "IssuerAlreadyRegistered");
				}
			});
		});

		describe("setIssuerStatus", function () {
			it("should activate/deactivate issuer", async function () {
				const { univerify, owner, issuer } = await loadFixture(deployFixture);
				await univerify.write.registerIssuer([issuer.account.address, issuerMetadataHash], {
					account: owner.account,
				});

				await univerify.write.setIssuerStatus([issuer.account.address, false], {
					account: owner.account,
				});
				expect(await univerify.read.authorizedIssuers([issuer.account.address])).to.equal(
					false,
				);
				let profile = readIssuerProfileTuple(
					(await univerify.read.issuerProfiles([
						issuer.account.address,
					])) as readonly unknown[],
				);
				expect(profile.status).to.equal(ISSUER_SUSPENDED);

				await univerify.write.setIssuerStatus([issuer.account.address, true], {
					account: owner.account,
				});
				expect(await univerify.read.authorizedIssuers([issuer.account.address])).to.equal(
					true,
				);
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

	describe("Certificate Issuance", function () {
		describe("issueCertificate", function () {
			it("should issue a valid certificate", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				const cert = readCertificateTuple(
					(await univerify.read.certificates([documentHash])) as readonly unknown[],
				);
				expect(cert.documentHash).to.equal(documentHash);
				expect(getAddress(cert.issuer)).to.equal(getAddress(issuer.account.address));
			});

			it("should store correct data", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				const issuedOn = 1_700_000_000n;
				const txHash = await univerify.write.issueCertificate(
					[studentIdentifierHash, documentHash, certificateType, issuedOn, metadataHash],
					{ account: issuer.account },
				);
				const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
				const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });

				const cert = readCertificateTuple(
					(await univerify.read.certificates([documentHash])) as readonly unknown[],
				);
				expect(getAddress(cert.issuer)).to.equal(getAddress(issuer.account.address));
				expect(cert.studentIdentifierHash).to.equal(studentIdentifierHash);
				expect(cert.documentHash).to.equal(documentHash);
				expect(cert.certificateType).to.equal(certificateType);
				expect(cert.issuedOn).to.equal(issuedOn);
				expect(cert.metadataHash).to.equal(metadataHash);
				expect(cert.fileReference).to.equal("");
				expect(cert.status).to.equal(STATUS_ACTIVE);
				expect(cert.issuedAt).to.equal(block.timestamp);
				expect(cert.revokedAt).to.equal(0n);
				expect(cert.revocationReasonHash).to.equal(
					"0x0000000000000000000000000000000000000000000000000000000000000000",
				);
			});

			it("should emit CertificateIssued event", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				const txHash = await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
				const logs = parseEventLogs({
					abi: univerify.abi,
					logs: receipt.logs,
					eventName: "CertificateIssued",
				});
				expect(logs).to.have.lengthOf(1);
				expect(logs[0].args.documentHash).to.equal(documentHash);
				expect(getAddress(logs[0].args.issuer!)).to.equal(
					getAddress(issuer.account.address),
				);
			});
		});

		describe("failure cases", function () {
			it("should revert if not authorized issuer", async function () {
				const { univerify, other } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.issueCertificate(
						[
							studentIdentifierHash,
							documentHash,
							certificateType,
							1_700_000_000n,
							metadataHash,
						],
						{ account: other.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "UnauthorizedIssuer");
				}
			});

			it("should revert if document_hash is zero", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.issueCertificate(
						[
							studentIdentifierHash,
							"0x0000000000000000000000000000000000000000000000000000000000000000",
							certificateType,
							1_700_000_000n,
							metadataHash,
						],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidDocumentHash");
				}
			});

			it("should revert if student_identifier_hash is zero", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.issueCertificate(
						[
							"0x0000000000000000000000000000000000000000000000000000000000000000",
							documentHash,
							certificateType,
							1_700_000_000n,
							metadataHash,
						],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidStudentIdentifierHash");
				}
			});

			it("should revert if metadata_hash is zero", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.issueCertificate(
						[
							studentIdentifierHash,
							documentHash,
							certificateType,
							1_700_000_000n,
							"0x0000000000000000000000000000000000000000000000000000000000000000",
						],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "InvalidMetadataHash");
				}
			});

			it("should revert if certificate_type is empty", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.issueCertificate(
						[studentIdentifierHash, documentHash, "", 1_700_000_000n, metadataHash],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "EmptyCertificateType");
				}
			});

			it("should revert if certificate already exists", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				try {
					await univerify.write.issueCertificate(
						[
							studentIdentifierHash,
							documentHash,
							certificateType,
							1_700_000_000n,
							metadataHash,
						],
						{ account: issuer.account },
					);
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateAlreadyExists");
				}
			});
		});
	});

	describe("Certificate Retrieval", function () {
		it("should retrieve certificate by document_hash", async function () {
			const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
			await univerify.write.issueCertificate(
				[
					studentIdentifierHash,
					documentHash,
					certificateType,
					1_700_000_000n,
					metadataHash,
				],
				{ account: issuer.account },
			);
			const cert = readCertificateTuple(
				(await univerify.read.certificates([documentHash])) as readonly unknown[],
			);
			expect(cert.documentHash).to.equal(documentHash);
		});

		it("should return correct issuer and status", async function () {
			const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
			await univerify.write.issueCertificate(
				[
					studentIdentifierHash,
					documentHash,
					certificateType,
					1_700_000_000n,
					metadataHash,
				],
				{ account: issuer.account },
			);
			const cert = readCertificateTuple(
				(await univerify.read.certificates([documentHash])) as readonly unknown[],
			);
			expect(getAddress(cert.issuer)).to.equal(getAddress(issuer.account.address));
			expect(cert.status).to.equal(STATUS_ACTIVE);
		});
	});

	describe("Revocation", function () {
		describe("revokeCertificate", function () {
			it("should allow issuer to revoke certificate", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				const txHash = await univerify.write.revokeCertificate(
					[documentHash, revocationReasonHash],
					{
						account: issuer.account,
					},
				);
				const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
				const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
				const cert = readCertificateTuple(
					(await univerify.read.certificates([documentHash])) as readonly unknown[],
				);
				expect(cert.status).to.equal(STATUS_REVOKED);
				expect(cert.revokedAt).to.equal(block.timestamp);
				expect(cert.revocationReasonHash).to.equal(revocationReasonHash);
			});

			it("should update status to Revoked", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				await univerify.write.revokeCertificate([documentHash, revocationReasonHash], {
					account: issuer.account,
				});
				const cert = readCertificateTuple(
					(await univerify.read.certificates([documentHash])) as readonly unknown[],
				);
				expect(cert.status).to.equal(STATUS_REVOKED);
			});

			// No CertificateRevoked event in the contract — nothing to assert here.
		});

		describe("failure cases", function () {
			it("should revert if certificate does not exist", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.revokeCertificate([documentHash, revocationReasonHash], {
						account: issuer.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateNotFound");
				}
			});

			it("should revert if already revoked", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				await univerify.write.revokeCertificate([documentHash, revocationReasonHash], {
					account: issuer.account,
				});
				try {
					await univerify.write.revokeCertificate([documentHash, revocationReasonHash], {
						account: issuer.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateAlreadyRevoked");
				}
			});

			it("should revert if caller is not issuer", async function () {
				const { univerify, issuer, other, owner } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.registerIssuer([other.account.address, issuerMetadataHash], {
					account: owner.account,
				});
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				try {
					await univerify.write.revokeCertificate([documentHash, revocationReasonHash], {
						account: other.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "NotCertificateIssuer");
				}
			});
		});
	});

	describe("File Reference", function () {
		const fileRef = "ipfs://QmExample";

		describe("attachFileReference", function () {
			it("should allow issuer to attach file reference", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				await univerify.write.attachFileReference([documentHash, fileRef], {
					account: issuer.account,
				});
				const cert = readCertificateTuple(
					(await univerify.read.certificates([documentHash])) as readonly unknown[],
				);
				expect(cert.fileReference).to.equal(fileRef);
			});

			it("should update field correctly", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash2,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				await univerify.write.attachFileReference([documentHash2, fileRef], {
					account: issuer.account,
				});
				const c2 = readCertificateTuple(
					(await univerify.read.certificates([documentHash2])) as readonly unknown[],
				);
				expect(c2.fileReference).to.equal(fileRef);
			});

			it("should emit event", async function () {
				const { univerify, issuer, publicClient } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				const txHash = await univerify.write.attachFileReference([documentHash, fileRef], {
					account: issuer.account,
				});
				const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
				const logs = parseEventLogs({
					abi: univerify.abi,
					logs: receipt.logs,
					eventName: "FileReferenceAttached",
				});
				expect(logs).to.have.lengthOf(1);
				expect(logs[0].args.documentHash).to.equal(documentHash);
			});
		});

		describe("failure cases", function () {
			it("should revert if certificate does not exist", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				try {
					await univerify.write.attachFileReference([documentHash, fileRef], {
						account: issuer.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "CertificateNotFound");
				}
			});

			it("should revert if caller is not issuer", async function () {
				const { univerify, issuer, other, owner } = await loadFixture(
					deployWithRegisteredIssuer,
				);
				await univerify.write.registerIssuer([other.account.address, issuerMetadataHash], {
					account: owner.account,
				});
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				try {
					await univerify.write.attachFileReference([documentHash, fileRef], {
						account: other.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "NotCertificateIssuer");
				}
			});

			it("should revert if empty reference", async function () {
				const { univerify, issuer } = await loadFixture(deployWithRegisteredIssuer);
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: issuer.account },
				);
				try {
					await univerify.write.attachFileReference([documentHash, ""], {
						account: issuer.account,
					});
					expect.fail("Should have reverted");
				} catch (e: unknown) {
					expectCustomError(e, "EmptyFileReference");
				}
			});
		});
	});

	describe("Access Control", function () {
		it("only owner can register issuer", async function () {
			const { univerify, issuer, other } = await loadFixture(deployFixture);
			try {
				await univerify.write.registerIssuer([other.account.address, issuerMetadataHash], {
					account: issuer.account,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "NotOwner");
			}
		});

		it("only owner can change issuer status", async function () {
			const { univerify, issuer, other, owner } = await loadFixture(deployFixture);
			await univerify.write.registerIssuer([issuer.account.address, issuerMetadataHash], {
				account: owner.account,
			});
			try {
				await univerify.write.setIssuerStatus([issuer.account.address, false], {
					account: issuer.account,
				});
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "NotOwner");
			}
		});

		it("only authorized issuers can issue certificates", async function () {
			const { univerify, other } = await loadFixture(deployFixture);
			try {
				await univerify.write.issueCertificate(
					[
						studentIdentifierHash,
						documentHash,
						certificateType,
						1_700_000_000n,
						metadataHash,
					],
					{ account: other.account },
				);
				expect.fail("Should have reverted");
			} catch (e: unknown) {
				expectCustomError(e, "UnauthorizedIssuer");
			}
		});
	});
});
