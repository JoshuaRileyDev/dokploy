// ssh2 is CommonJS and Node's ESM loader only detects some of its exports;
// `utils` is reachable through the default export alone, which also works
// when the code is bundled.
import ssh2 from "ssh2";

export const generateSSHKey = async (type: "rsa" | "ed25519" = "rsa") => {
	try {
		if (type === "rsa") {
			const keys = ssh2.utils.generateKeyPairSync("rsa", {
				bits: 4096,
				comment: "dokploy",
			});
			return {
				privateKey: keys.private,
				publicKey: keys.public,
			};
		}
		const keys = ssh2.utils.generateKeyPairSync("ed25519", {
			comment: "dokploy",
		});

		return {
			privateKey: keys.private,
			publicKey: keys.public,
		};
	} catch (error) {
		throw error;
	}
};
