interface ImageOption {
	id: string;
	label: string;
	osFlavor: string;
}

// Ubuntu LTS releases are the even-year April ones (22.04, 24.04, 26.04).
const ltsVersion = (image: ImageOption) => {
	const match = `${image.label} ${image.id}`.match(/(\d{2})[.-]04/);
	const year = match ? Number(match[1]) : Number.NaN;
	return image.osFlavor === "ubuntu" && year % 2 === 0 ? year : null;
};

/**
 * The newest Ubuntu LTS, so a server isn't created on a short-lived interim
 * release just because providers list those first. Falls back to any Ubuntu,
 * then the first image.
 */
export const defaultImage = <T extends ImageOption>(images: T[]) =>
	[...images]
		.filter((image) => ltsVersion(image) !== null)
		.sort((a, b) => (ltsVersion(b) ?? 0) - (ltsVersion(a) ?? 0))[0] ??
	images.find((image) => image.osFlavor === "ubuntu") ??
	images[0];
