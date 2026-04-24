import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
	"pdfjs-dist/build/pdf.worker.mjs",
	import.meta.url,
).toString();

interface Props {
	bytes: Uint8Array;
}

interface RenderedPage {
	pageNum: number;
	dataUrl: string;
	width: number;
	height: number;
}

export default function PdfViewer({ bytes }: Props) {
	const [pages, setPages] = useState<RenderedPage[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		setPages([]);

		const task = pdfjsLib.getDocument({ data: bytes.slice() });

		task.promise
			.then(async (pdf) => {
				const dpr = window.devicePixelRatio || 1;
				const containerWidth = containerRef.current?.offsetWidth || 680;
				const rendered: RenderedPage[] = [];

				for (let i = 1; i <= pdf.numPages; i++) {
					if (cancelled) break;
					const page = await pdf.getPage(i);
					const baseViewport = page.getViewport({ scale: 1 });
					const scale = (containerWidth / baseViewport.width) * dpr;
					const viewport = page.getViewport({ scale });

					const canvas = document.createElement("canvas");
					canvas.width = viewport.width;
					canvas.height = viewport.height;
					const ctx = canvas.getContext("2d")!;

					await page.render({ canvasContext: ctx, viewport, canvas }).promise;
					if (!cancelled) {
						rendered.push({
							pageNum: i,
							dataUrl: canvas.toDataURL("image/png"),
							width: viewport.width,
							height: viewport.height,
						});
					}
					page.cleanup();
				}

				if (!cancelled) {
					setPages(rendered);
					setLoading(false);
				}
				pdf.destroy();
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
					setLoading(false);
				}
			});

		return () => {
			cancelled = true;
			task.destroy();
		};
	}, [bytes]);

	return (
		<div ref={containerRef} className="w-full bg-white rounded-lg overflow-hidden">
			{loading && (
				<div className="flex items-center justify-center py-12 text-sm text-gray-500">
					Rendering PDF…
				</div>
			)}
			{error && (
				<div className="p-4 text-sm text-red-600">
					Failed to render PDF: {error}
				</div>
			)}
			{pages.map((p) => (
				<img
					key={p.pageNum}
					src={p.dataUrl}
					alt={`Page ${p.pageNum}`}
					style={{ width: "100%", display: "block" }}
					draggable={false}
				/>
			))}
		</div>
	);
}
