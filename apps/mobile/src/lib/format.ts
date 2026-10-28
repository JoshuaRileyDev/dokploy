export function timeAgo(iso: string | null | undefined) {
	if (!iso) return "—";
	const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
	if (seconds < 45) return "just now";
	const minutes = seconds / 60;
	if (minutes < 60) return `${Math.round(minutes)}m ago`;
	const hours = minutes / 60;
	if (hours < 24) return `${Math.round(hours)}h ago`;
	const days = hours / 24;
	if (days < 30) return `${Math.round(days)}d ago`;
	return new Date(iso).toLocaleDateString(undefined, {
		day: "numeric",
		month: "short",
	});
}

export function duration(
	start: string | null | undefined,
	end: string | null | undefined,
) {
	if (!start) return "";
	const ms =
		(end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bytes(n: number) {
	if (!Number.isFinite(n)) return "—";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let i = 0;
	let v = n;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function initials(name: string) {
	return name
		.split(/[\s-_]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((p) => p[0]!.toUpperCase())
		.join("");
}
