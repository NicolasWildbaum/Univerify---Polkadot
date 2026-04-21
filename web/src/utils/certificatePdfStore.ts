import { type Address, type Hex } from "viem";
import { type VerifiableCredential } from "./credential";
import { buildCertificatePdfBytes } from "./certificatePdf";

const STORAGE_KEY = "univerify:certificate-pdfs:v1";

interface StoredCertificatePdfRecordWire {
	version: 1;
	certificateId: Hex;
	claimsHash: Hex;
	credential: VerifiableCredential;
	studentAddress: Address;
	issuerName: string;
	pdfBase64: string;
	pdfCid: string | null;
	createdAt: string;
}

export interface StoredCertificatePdfRecord {
	certificateId: Hex;
	claimsHash: Hex;
	credential: VerifiableCredential;
	studentAddress: Address;
	issuerName: string;
	pdfBytes: Uint8Array;
	pdfCid: string | null;
	createdAt: string;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function loadAll(): Record<string, StoredCertificatePdfRecordWire> {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Record<string, StoredCertificatePdfRecordWire>;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

function saveAll(next: Record<string, StoredCertificatePdfRecordWire>) {
	localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
}

function toStoredRecord(
	record: StoredCertificatePdfRecordWire,
): StoredCertificatePdfRecord {
	return {
		certificateId: record.certificateId,
		claimsHash: record.claimsHash,
		credential: record.credential,
		studentAddress: record.studentAddress,
		issuerName: record.issuerName,
		pdfBytes: base64ToBytes(record.pdfBase64),
		pdfCid: record.pdfCid,
		createdAt: record.createdAt,
	};
}

function toWireRecord(
	record: StoredCertificatePdfRecord,
): StoredCertificatePdfRecordWire {
	return {
		version: 1,
		certificateId: record.certificateId,
		claimsHash: record.claimsHash,
		credential: record.credential,
		studentAddress: record.studentAddress,
		issuerName: record.issuerName,
		pdfBase64: bytesToBase64(record.pdfBytes),
		pdfCid: record.pdfCid,
		createdAt: record.createdAt,
	};
}

export function getStoredCertificatePdf(
	certificateId: Hex,
): StoredCertificatePdfRecord | null {
	const entry = loadAll()[certificateId.toLowerCase()];
	return entry ? toStoredRecord(entry) : null;
}

export function storeGeneratedCertificatePdf(params: {
	credential: VerifiableCredential;
	claimsHash: Hex;
	studentAddress: Address;
	issuerName?: string;
	pdfCid?: string | null;
}): StoredCertificatePdfRecord {
	const issuerName = params.issuerName?.trim() || params.credential.claims.institutionName;
	const pdfBytes = buildCertificatePdfBytes({
		credential: params.credential,
		claimsHash: params.claimsHash,
		issuerName,
		studentAddress: params.studentAddress,
		verifyUrl: `${window.location.origin}/#/verify/cert/${params.credential.certificateId}`,
	});

	const record: StoredCertificatePdfRecord = {
		certificateId: params.credential.certificateId,
		claimsHash: params.claimsHash,
		credential: params.credential,
		studentAddress: params.studentAddress,
		issuerName,
		pdfBytes,
		pdfCid: params.pdfCid ?? null,
		createdAt: new Date().toISOString(),
	};

	const all = loadAll();
	all[record.certificateId.toLowerCase()] = toWireRecord(record);
	saveAll(all);
	return record;
}

export function storeFetchedCertificatePdf(params: {
	certificateId: Hex;
	pdfBytes: Uint8Array;
	pdfCid: string;
	claimsHash?: Hex;
	credential?: VerifiableCredential;
	studentAddress?: Address;
	issuerName?: string;
}) {
	const all = loadAll();
	const existing = all[params.certificateId.toLowerCase()];
	const next: StoredCertificatePdfRecordWire = existing
		? {
				...existing,
				pdfBase64: bytesToBase64(params.pdfBytes),
				pdfCid: params.pdfCid,
			}
		: {
				version: 1,
				certificateId: params.certificateId,
				claimsHash:
					params.claimsHash ??
					("0x0000000000000000000000000000000000000000000000000000000000000000" as Hex),
				credential:
					params.credential ?? {
						certificateId: params.certificateId,
						issuer:
							"0x0000000000000000000000000000000000000000" as Hex,
						claims: {
							degreeTitle: "",
							holderName: "",
							institutionName: "",
							issuanceDate: "",
						},
					},
				studentAddress:
					params.studentAddress ??
					("0x0000000000000000000000000000000000000000" as Address),
				issuerName: params.issuerName ?? "",
				pdfBase64: bytesToBase64(params.pdfBytes),
				pdfCid: params.pdfCid,
				createdAt: new Date().toISOString(),
			};
	all[params.certificateId.toLowerCase()] = next;
	saveAll(all);
}

export function setStoredCertificatePdfCid(certificateId: Hex, pdfCid: string) {
	const all = loadAll();
	const key = certificateId.toLowerCase();
	const existing = all[key];
	if (!existing) return;
	all[key] = { ...existing, pdfCid };
	saveAll(all);
}
