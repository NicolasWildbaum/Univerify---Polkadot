import { type Address, type Hex } from "viem";
import {
	computeClaimsHash,
	parseVerifiableCredential,
	type VerifiableCredential,
} from "./credential";

export const PDF_PAYLOAD_VERSION = "univerify-pdf-payload-v1";
const PDF_PAYLOAD_MARKER = "UNIVERIFY_PAYLOAD_V1:";
const PDF_HEADER = "%PDF-1.4\n%UNIVERIFY\n";

export interface CertificatePdfPayload {
	version: typeof PDF_PAYLOAD_VERSION;
	credential: VerifiableCredential;
	claimsHash: Hex;
}

interface CertificatePdfOptions {
	credential: VerifiableCredential;
	claimsHash: Hex;
	issuerName?: string;
	studentAddress?: Address | null;
	verifyUrl?: string;
}

function base64UrlEncode(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(text: string): string {
	const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

function escapePdfText(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(value: string, maxLen = 76): string[] {
	if (value.length <= maxLen) return [value];
	const words = value.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		const next = current ? `${current} ${word}` : word;
		if (next.length <= maxLen) {
			current = next;
			continue;
		}
		if (current) lines.push(current);
		if (word.length <= maxLen) {
			current = word;
			continue;
		}
		for (let i = 0; i < word.length; i += maxLen) {
			lines.push(word.slice(i, i + maxLen));
		}
		current = "";
	}
	if (current) lines.push(current);
	return lines;
}

function approximateCenteredX(text: string, fontSize: number): number {
	const estimatedWidth = text.length * fontSize * 0.43;
	return Math.max(48, (595 - estimatedWidth) / 2);
}

function drawText(
	font: "F1" | "F2" | "F3",
	size: number,
	x: number,
	y: number,
	text: string,
): string {
	return `BT /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${escapePdfText(text)}) Tj ET`;
}

function makePdfContent(options: CertificatePdfOptions): string {
	const institution = options.issuerName?.trim() || options.credential.claims.institutionName;
	const holderName = options.credential.claims.holderName;
	const degreeTitle = options.credential.claims.degreeTitle;
	const metaLines = [
		`Institution: ${institution}`,
		`Issuance Month: ${options.credential.claims.issuanceDate}`,
		`Certificate ID: ${options.credential.certificateId}`,
		...(options.studentAddress ? [`Student Wallet: ${options.studentAddress}`] : []),
		...(options.verifyUrl ? [`Public Verifier: ${options.verifyUrl}`] : []),
	];

	const commands = [
		"0.76 0.66 0.40 RG",
		"3 w",
		"36 36 523 770 re S",
		"0.88 0.83 0.68 RG",
		"1 w",
		"52 52 491 738 re S",
		"0.17 0.20 0.28 rg",
		drawText("F1", 17, approximateCenteredX("UNIVERIFY", 17), 770, "UNIVERIFY"),
		"0.38 0.29 0.08 rg",
		drawText(
			"F1",
			30,
			approximateCenteredX("Certificate of Academic Achievement", 30),
			722,
			"Certificate of Academic Achievement",
		),
		"0.35 0.35 0.35 rg",
		drawText("F2", 14, approximateCenteredX("This certifies that", 14), 666, "This certifies that"),
		"0.12 0.12 0.12 rg",
		drawText("F1", 24, approximateCenteredX(holderName, 24), 618, holderName),
		"0.35 0.35 0.35 rg",
		drawText("F2", 14, approximateCenteredX("has been awarded the academic credential", 14), 574, "has been awarded the academic credential"),
		"0.15 0.18 0.24 rg",
		drawText("F1", 20, approximateCenteredX(degreeTitle, 20), 528, degreeTitle),
		"0.35 0.35 0.35 rg",
		drawText("F2", 14, approximateCenteredX("issued by", 14), 484, "issued by"),
		"0.21 0.16 0.06 rg",
		drawText("F1", 18, approximateCenteredX(institution, 18), 450, institution),
		"0.78 0.73 0.60 RG",
		"1 w",
		"84 402 427 0 m 511 402 l S",
		"0.22 0.22 0.22 rg",
		drawText("F2", 11, 84, 374, "Official credential summary"),
	];

	let y = 350;
	for (const line of metaLines) {
		for (const wrapped of wrapText(line, 64)) {
			commands.push(drawText("F3", 10, 84, y, wrapped));
			y -= 16;
		}
		y -= 4;
	}

	commands.push(
		"0.35 0.35 0.35 rg",
		drawText(
			"F2",
			9,
			84,
			104,
			"This PDF includes an embedded machine-readable Univerify payload for automatic integrity verification.",
		),
	);

	return `${commands.join("\n")}\n`;
}

export function buildCertificatePdfBytes(options: CertificatePdfOptions): Uint8Array {
	const payload: CertificatePdfPayload = {
		version: PDF_PAYLOAD_VERSION,
		credential: options.credential,
		claimsHash: options.claimsHash,
	};
	const payloadLine = `%${PDF_PAYLOAD_MARKER}${base64UrlEncode(JSON.stringify(payload))}\n`;

	const encoder = new TextEncoder();
	const content = makePdfContent(options);
	const contentBytes = encoder.encode(content);

	const objects = [
		"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
		"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
		"3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R /F2 5 0 R /F3 6 0 R >> >> /Contents 7 0 R >>\nendobj\n",
		"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>\nendobj\n",
		"5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>\nendobj\n",
		"6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>\nendobj\n",
		`7 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n${content}endstream\nendobj\n`,
	];

	let pdf = `${PDF_HEADER}${payloadLine}`;
	const offsets: number[] = [];
	for (const obj of objects) {
		offsets.push(encoder.encode(pdf).length);
		pdf += obj;
	}

	const xrefOffset = encoder.encode(pdf).length;
	pdf += `xref\n0 ${objects.length + 1}\n`;
	pdf += "0000000000 65535 f \n";
	for (const offset of offsets) {
		pdf += `${offset.toString().padStart(10, "0")} 00000 n \n`;
	}
	pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
	pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

	return encoder.encode(pdf);
}

export function downloadPdfBytes(bytes: Uint8Array, filename: string) {
	const blob = new Blob([bytes], { type: "application/pdf" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

export function looksLikePdf(bytes: Uint8Array): boolean {
	return (
		bytes.length >= 4 &&
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46
	);
}

export function extractCertificatePdfPayload(
	bytes: Uint8Array,
):
	| { ok: true; payload: CertificatePdfPayload }
	| { ok: false; error: string } {
	const raw = new TextDecoder().decode(bytes);
	const marker = `%${PDF_PAYLOAD_MARKER}`;
	const start = raw.indexOf(marker);
	if (start === -1) {
		return {
			ok: false,
			error:
				"This PDF does not contain a Univerify machine-readable payload. Older or external PDFs can still be checked manually.",
		};
	}

	const end = raw.indexOf("\n", start);
	const encoded = raw
		.slice(start + marker.length, end === -1 ? undefined : end)
		.trim();
	if (!encoded) {
		return { ok: false, error: "The embedded Univerify PDF payload is empty." };
	}

	try {
		const parsed = JSON.parse(base64UrlDecode(encoded)) as {
			version?: string;
			credential?: unknown;
			claimsHash?: unknown;
		};
		if (parsed.version !== PDF_PAYLOAD_VERSION) {
			return {
				ok: false,
				error: `Unsupported PDF payload version "${String(parsed.version ?? "")}".`,
			};
		}
		const credential = parseVerifiableCredential(parsed.credential);
		if (!credential.ok) return { ok: false, error: credential.error };
		const recomputedHash = computeClaimsHash(credential.credential.claims);
		const claimsHash =
			typeof parsed.claimsHash === "string" &&
			/^0x[0-9a-fA-F]{64}$/.test(parsed.claimsHash)
				? (parsed.claimsHash as Hex)
				: recomputedHash;
		return {
			ok: true,
			payload: {
				version: PDF_PAYLOAD_VERSION,
				credential: credential.credential,
				claimsHash,
			},
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
