import {
	type CloudCatalog,
	getCloudProviderDefinition,
} from "@dokploy/server/utils/cloud-providers";
import {
	findCloudProviderAccountsByOrganizationId,
	getCloudCatalog,
} from "./cloud-provider";

const ECB_RATES_URL =
	"https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";

// The ECB publishes once per working day.
const RATES_TTL_MS = 6 * 60 * 60_000;

export interface ExchangeRates {
	/** Units of each currency per euro. */
	perEuro: Record<string, number>;
	date: string;
}

let cachedRates: { value: ExchangeRates; fetchedAt: number } | null = null;

export const parseEcbRates = (xml: string): ExchangeRates | null => {
	const date = xml.match(/time=['"](\d{4}-\d{2}-\d{2})['"]/)?.[1];
	const perEuro: Record<string, number> = { EUR: 1 };
	for (const match of xml.matchAll(
		/currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g,
	)) {
		const rate = Number(match[2]);
		if (rate > 0) perEuro[match[1] as string] = rate;
	}
	return date && Object.keys(perEuro).length > 1 ? { perEuro, date } : null;
};

export const getExchangeRates = async () => {
	if (cachedRates && Date.now() - cachedRates.fetchedAt < RATES_TTL_MS) {
		return cachedRates.value;
	}
	try {
		const response = await fetch(ECB_RATES_URL, {
			signal: AbortSignal.timeout(10_000),
		});
		const rates = response.ok ? parseEcbRates(await response.text()) : null;
		if (rates) cachedRates = { value: rates, fetchedAt: Date.now() };
		return rates ?? cachedRates?.value ?? null;
	} catch {
		return cachedRates?.value ?? null;
	}
};

const CONTINENTS: Record<string, string> = {
	...Object.fromEntries(
		"AT BE CH CZ DE DK ES FI FR GB IE IT LU NL NO PL PT SE"
			.split(" ")
			.map((code) => [code, "Europe"]),
	),
	...Object.fromEntries(
		"US CA MX".split(" ").map((code) => [code, "North America"]),
	),
	...Object.fromEntries(
		"BR CL CO AR".split(" ").map((code) => [code, "South America"]),
	),
	...Object.fromEntries(
		"SG JP IN KR HK ID IL AE TW".split(" ").map((code) => [code, "Asia"]),
	),
	AU: "Oceania",
	NZ: "Oceania",
	ZA: "Africa",
};

export const continentOf = (country: string) =>
	CONTINENTS[country.toUpperCase()] ?? "Other";

export interface CloudOffer {
	cloudProviderAccountId: string;
	serverType: string;
	label: string;
	family: string;
	cores: number | null;
	memoryGb: number | null;
	diskGb: number;
	architecture: "x86" | "arm";
	/** Only locations where the type can be ordered now. */
	locations: {
		id: string;
		/** Before tax, so providers that quote VAT and ones that don't compare fairly. */
		monthly: number | null;
	}[];
}

const offersFrom = (accountId: string, catalog: CloudCatalog): CloudOffer[] =>
	catalog.serverTypes
		.map((type) => ({
			cloudProviderAccountId: accountId,
			serverType: type.id,
			label: type.label,
			family: type.family,
			cores: type.cores,
			memoryGb: type.memoryGb,
			diskGb: type.diskGb,
			architecture: type.architecture,
			locations: catalog.locations
				.filter((location) => location.availableServerTypes.includes(type.id))
				.flatMap((location) => {
					const price = type.prices.find((p) => p.location === location.id);
					return price
						? [
								{
									id: location.id,
									monthly:
										price.monthlyNet !== undefined
											? price.monthlyNet
											: price.monthly,
								},
							]
						: [];
				}),
		}))
		.filter((offer) => offer.locations.length > 0);

/**
 * Every server type across the organization's cloud accounts, with the
 * locations it can be ordered in and its price there, for side-by-side
 * comparison. Accounts whose catalog fails are reported, not dropped.
 */
export const compareCloudOffers = async (organizationId: string) => {
	const [accounts, rates] = await Promise.all([
		findCloudProviderAccountsByOrganizationId(organizationId),
		getExchangeRates(),
	]);
	const results = await Promise.all(
		accounts.map(async (account) => {
			const definition = getCloudProviderDefinition(account.providerType);
			const summary = {
				cloudProviderAccountId: account.cloudProviderAccountId,
				name: account.name,
				providerType: account.providerType,
				providerLabel: definition.label,
				removal: definition.removal ?? "delete",
			};
			try {
				const catalog = await getCloudCatalog(account);
				return {
					account: {
						...summary,
						currency: catalog.currency,
						error: null,
						locations: catalog.locations.map((location) => ({
							id: location.id,
							city: location.city,
							country: location.country,
							continent: continentOf(location.country),
						})),
					},
					offers: offersFrom(account.cloudProviderAccountId, catalog),
				};
			} catch (error) {
				return {
					account: {
						...summary,
						currency: null,
						error:
							error instanceof Error
								? error.message
								: "Could not load server options",
						locations: [],
					},
					offers: [],
				};
			}
		}),
	);
	return {
		rates,
		accounts: results.map((result) => result.account),
		offers: results.flatMap((result) => result.offers),
	};
};
