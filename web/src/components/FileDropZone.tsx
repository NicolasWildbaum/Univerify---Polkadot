import { useState, useCallback, type DragEvent } from "react";
import { hashFileWithBytes } from "../utils/hash";

interface Props {
	onFileHashed: (hash: `0x${string}`, fileName: string) => void;
	onFileBytes?: (bytes: Uint8Array) => void;
	showUploadToggle?: boolean;
	uploadToIpfs?: boolean;
	onUploadToggle?: (enabled: boolean) => void;
}

export default function FileDropZone({
	onFileHashed,
	onFileBytes,
	showUploadToggle,
	uploadToIpfs,
	onUploadToggle,
}: Props) {
	const [dragging, setDragging] = useState(false);
	const [fileName, setFileName] = useState<string | null>(null);
	const [hashing, setHashing] = useState(false);

	const processFile = useCallback(
		async (file: File) => {
			setFileName(file.name);
			setHashing(true);
			try {
				const { hash, bytes } = await hashFileWithBytes(file);
				onFileHashed(hash, file.name);
				onFileBytes?.(bytes);
			} finally {
				setHashing(false);
			}
		},
		[onFileHashed, onFileBytes],
	);

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		setDragging(false);
		const file = e.dataTransfer.files[0];
		if (file) processFile(file);
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
		setDragging(true);
	}

	function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (file) processFile(file);
	}

	return (
		<div className="space-y-3">
			<div
				onDrop={handleDrop}
				onDragOver={handleDragOver}
				onDragLeave={() => setDragging(false)}
				className={`relative overflow-hidden border-2 border-dashed rounded-[1.75rem] p-8 text-center transition-all duration-300 cursor-pointer ${
					dragging
						? "border-[#12b7ff] bg-[#12b7ff]/[0.08] shadow-[0_0_0_4px_rgba(18,183,255,0.12)]"
						: "border-white/[0.08] bg-white/[0.02] hover:border-white/[0.15] hover:bg-white/[0.03]"
				}`}
			>
				<div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(18,183,255,0.12),transparent_34%)]" />
				<input type="file" onChange={handleFileInput} className="hidden" id="file-input" />
				<label htmlFor="file-input" className="relative block cursor-pointer space-y-3">
					<div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.06]">
						<svg viewBox="0 0 24 24" className="h-6 w-6 text-white" fill="none" stroke="currentColor" strokeWidth="1.6">
							<path d="M12 16V5m0 0 4 4m-4-4L8 9" strokeLinecap="round" strokeLinejoin="round" />
							<path d="M5 16.5v1A1.5 1.5 0 0 0 6.5 19h11a1.5 1.5 0 0 0 1.5-1.5v-1" strokeLinecap="round" />
						</svg>
					</div>
					{hashing ? (
						<p className="text-accent-yellow font-medium">Hashing...</p>
					) : fileName ? (
						<p className="text-text-primary">
							{fileName}{" "}
							<span className="text-text-muted text-sm">
								(drop another to replace)
							</span>
						</p>
					) : (
						<div className="space-y-1">
							<p className="text-text-primary font-medium text-base">
								Drop a file here or click to browse
							</p>
							<p className="text-text-muted text-sm">
								Your document stays local while we compute its Blake2b-256 hash for
								on-chain use.
							</p>
						</div>
					)}
				</label>
			</div>
			{showUploadToggle && (
				<label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
					<input
						type="checkbox"
						checked={uploadToIpfs ?? false}
						onChange={(e) => onUploadToggle?.(e.target.checked)}
						className="rounded border-white/[0.15] bg-white/[0.04] text-polka-500 focus:ring-polka-500/30"
					/>
					Upload file to IPFS (via Bulletin Chain)
					<a
						href="https://paritytech.github.io/polkadot-bulletin-chain/"
						target="_blank"
						rel="noopener noreferrer"
						className="text-text-muted text-xs hover:text-text-secondary underline"
					>
						— requires authorization, expires ~7 days
					</a>
				</label>
			)}
		</div>
	);
}
