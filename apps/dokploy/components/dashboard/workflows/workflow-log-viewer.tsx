import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { TerminalLine } from "@/components/dashboard/docker/logs/terminal-line";
import { parseLogs } from "@/components/dashboard/docker/logs/utils";

interface Props {
	logPath: string;
	emptyMessage?: string;
}

export const WorkflowLogViewer = ({ logPath, emptyMessage }: Props) => {
	const [data, setData] = useState("");
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

	return (
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
					<TerminalLine key={`${log.rawTimestamp ?? ""}-${index}`} log={log} />
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
	);
};
