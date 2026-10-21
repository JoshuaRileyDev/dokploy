import copy from "copy-to-clipboard";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalLine } from "@/components/dashboard/docker/logs/terminal-line";
import { parseLogs } from "@/components/dashboard/docker/logs/utils";
import { Button } from "@/components/ui/button";

interface Props {
	logPath: string;
	/** Name for the downloaded file, without the .log extension. */
	fileName: string;
	emptyMessage?: string;
}

export const WorkflowLogViewer = ({
	logPath,
	fileName,
	emptyMessage,
}: Props) => {
	const [data, setData] = useState("");
	const [copied, setCopied] = useState(false);
	const [closed, setClosed] = useState(false);
	const [autoScroll, setAutoScroll] = useState(true);
	const scrollRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		setData("");
		setClosed(false);
		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(
			`${protocol}//${window.location.host}/listen-deployment?logPath=${encodeURIComponent(logPath)}`,
		);
		ws.onmessage = (event) => setData((current) => current + event.data);
		ws.onclose = () => setClosed(true);
		return () => ws.close();
	}, [logPath]);

	const logs = useMemo(() => parseLogs(data), [data]);

	useEffect(() => {
		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [logs, autoScroll]);

	const handleCopy = () => {
		if (copy(data)) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleDownload = () => {
		const url = URL.createObjectURL(new Blob([data], { type: "text/plain" }));
		const link = document.createElement("a");
		link.href = url;
		link.download = `${fileName.replace(/[^\w.-]+/g, "-")}.log`;
		link.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-end gap-2">
				<span className="mr-auto text-xs text-muted-foreground tabular-nums">
					{logs.length} lines
				</span>
				<Button
					variant="outline"
					size="sm"
					onClick={handleCopy}
					disabled={!data}
				>
					{copied ? (
						<Check className="size-3.5" />
					) : (
						<Copy className="size-3.5" />
					)}
					{copied ? "Copied" : "Copy"}
				</Button>
				<Button
					variant="outline"
					size="sm"
					onClick={handleDownload}
					disabled={!data}
				>
					<Download className="size-3.5" />
					Download
				</Button>
			</div>
			<div
				ref={scrollRef}
				onScroll={() => {
					const el = scrollRef.current;
					if (!el) return;
					setAutoScroll(el.scrollHeight - el.scrollTop - el.clientHeight < 10);
				}}
				className="custom-logs-scrollbar h-[560px] overflow-y-auto rounded border bg-background p-4"
			>
				{logs.length > 0 ? (
					logs.map((log, index) => (
						<TerminalLine
							key={`${log.rawTimestamp ?? ""}-${index}`}
							log={log}
						/>
					))
				) : closed ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						{emptyMessage ?? "No output."}
					</div>
				) : (
					<div className="flex h-full items-center justify-center text-muted-foreground">
						<Loader2 className="size-6 animate-spin" />
					</div>
				)}
			</div>
		</div>
	);
};
