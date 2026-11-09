import { describe, expect, it } from "vitest";
import { defaultImage } from "@/components/dashboard/settings/servers/default-image";

const image = (id: string, label: string, osFlavor = "ubuntu") => ({
	id,
	label,
	osFlavor,
});

describe("defaultImage", () => {
	it("picks the newest Ubuntu LTS over newer interim releases", () => {
		expect(
			defaultImage([
				image("2838", "Ubuntu 26.10 x64"),
				image("2760", "Ubuntu 26.04 LTS x64"),
				image("2284", "Ubuntu 24.04 LTS x64"),
				image("2136", "Debian 12 x64 (bookworm)", "debian"),
			])?.id,
		).toBe("2760");
	});

	it("reads versions from ids like DigitalOcean and Hetzner use", () => {
		expect(
			defaultImage([
				image("ubuntu-25-10-x64", "Ubuntu 25.10 x64"),
				image("ubuntu-24-04-x64", "Ubuntu 24.04 (LTS) x64"),
			])?.id,
		).toBe("ubuntu-24-04-x64");
		expect(
			defaultImage([
				image("ubuntu-24.04", "Ubuntu 24.04"),
				image("ubuntu-22.04", "Ubuntu 22.04"),
			])?.id,
		).toBe("ubuntu-24.04");
	});

	it("falls back to any Ubuntu, then the first image", () => {
		expect(defaultImage([image("u", "Ubuntu 25.10")])?.id).toBe("u");
		expect(defaultImage([image("d", "Debian 12", "debian")])?.id).toBe("d");
		expect(defaultImage([])).toBeUndefined();
	});
});
