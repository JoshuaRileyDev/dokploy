const MIB = 1024 ** 2;

export const formatBytes = (bytes: number) =>
	bytes >= 1024 ** 3
		? `${(bytes / 1024 ** 3).toFixed(1)} GB`
		: `${Math.round(bytes / MIB)} MB`;
