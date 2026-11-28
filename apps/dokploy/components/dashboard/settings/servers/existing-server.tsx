import {
	ArrowLeft,
	Copy,
	Cpu,
	HardDrive,
	KeyRound,
	Loader2,
	MemoryStick,
	Plus,
	RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CloudProviderIcon } from "@/components/icons/cloud-provider-icons";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";

type ProviderDefinition = RouterOutputs["cloudProvider"]["providers"][number];
type Account = RouterOutputs["cloudProvider"]["all"][number];
type ExistingServer = RouterOutputs["cloudProvider"]["existingServers"][number];
type Access = "key" | "password" | "provider";

const toServerName = (name: string) =>
	name
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 63);

const unavailableReason = (server: ExistingServer) =>
	server.dokployServer
		? `Already in Dokploy as ${server.dokployServer.name}`
		: !server.ipv4
			? "No public IPv4 address"
			: server.status !== "running"
				? `Not running (${server.status.replace(/_/g, " ")})`
				: null;

const copy = (text: string) =>
	navigator.clipboard
		.writeText(text)
		.then(() => toast.success("Copied"))
		.catch(() => toast.error("Could not copy"));

export const ExistingServer = ({
	providers,
	accounts,
	onBack,
	onAdded,
}: {
	providers: ProviderDefinition[];
	accounts: Account[];
	onBack: () => void;
	onAdded: () => void;
}) => {
	const utils = api.useUtils();
	const [accountId, setAccountId] = useState(
		accounts[0]?.cloudProviderAccountId ?? "",
	);
	const [serverId, setServerId] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState<"deploy" | "build">("deploy");
	const [sshKeyId, setSshKeyId] = useState("");
	const [access, setAccess] = useState<Access>("key");
	const [password, setPassword] = useState("");
	const [username, setUsername] = useState("root");
	const [port, setPort] = useState(22);
	const [runSetup, setRunSetup] = useState(true);

	useEffect(() => {
		if (!accounts.some((a) => a.cloudProviderAccountId === accountId)) {
			setAccountId(accounts[0]?.cloudProviderAccountId ?? "");
		}
	}, [accounts, accountId]);

	const account = accounts.find((a) => a.cloudProviderAccountId === accountId);
	const provider = providers.find((p) => p.type === account?.providerType);

	const {
		data: servers,
		isFetching: isLoadingServers,
		error: serversError,
		refetch: refetchServers,
	} = api.cloudProvider.existingServers.useQuery(
		{ cloudProviderAccountId: accountId },
		{ enabled: !!accountId, retry: false },
	);
	const { data: sshKeys, error: sshKeysError } = api.sshKey.all.useQuery();

	const { mutateAsync: generateKey, isPending: isGenerating } =
		api.cloudProvider.generateServerKey.useMutation();
	const { mutateAsync: adopt, isPending: isAdding } =
		api.cloudProvider.adoptServer.useMutation();

	const selected = servers?.find((s) => s.id === serverId);
	const selectedKey = sshKeys?.find((k) => k.sshKeyId === sshKeyId);

	const sortedServers = useMemo(
		() =>
			[...(servers ?? [])].sort(
				(a, b) =>
					Number(!!unavailableReason(a)) - Number(!!unavailableReason(b)) ||
					a.name.localeCompare(b.name),
			),
		[servers],
	);

	const selectServer = (server: ExistingServer) => {
		setServerId(server.id);
		setName(toServerName(server.name));
	};

	const createKey = async () => {
		const label = name || selected?.name || "server";
		await generateKey({ name: `${label} (${provider?.label ?? "cloud"})` })
			.then(async (key) => {
				await utils.sshKey.all.invalidate();
				setSshKeyId(key.sshKeyId);
				toast.success(`Created the SSH key ${key.name}`);
			})
			.catch((error) =>
				toast.error("Could not create an SSH key", {
					description: error.message,
				}),
			);
	};

	const installCommand = selectedKey
		? `mkdir -p ~/.ssh && echo '${selectedKey.publicKey.trim()}' >> ~/.ssh/authorized_keys`
		: "";

	const canSubmit =
		!!selected &&
		!unavailableReason(selected) &&
		!!name.trim() &&
		!!sshKeyId &&
		(access !== "password" || !!password);

	const onSubmit = async () => {
		if (!selected || !account) return;
		await adopt({
			cloudProviderAccountId: account.cloudProviderAccountId,
			providerServerId: selected.id,
			name: name.trim(),
			role,
			sshKeyId,
			username: username.trim() || "root",
			port,
			access,
			password: access === "password" ? password : undefined,
			runSetup,
		})
			.then(async () => {
				toast.success(`Adding ${name} from ${provider?.label}`);
				setPassword("");
				await Promise.all([
					utils.cloudProvider.provisionings.invalidate(),
					utils.cloudProvider.existingServers.invalidate(),
					utils.server.all.invalidate(),
				]);
				onAdded();
			})
			.catch((error) =>
				toast.error("Could not add the server", {
					description: error.message,
				}),
			);
	};

	const accessOptions: { id: Access; title: string; description: string }[] = [
		{
			id: "key",
			title: "It's already on the server",
			description: "Dokploy checks it can log in with the key.",
		},
		{
			id: "password",
			title: "Add it with the password",
			description:
				"Dokploy logs in once with the password to add the key. The password isn't stored.",
		},
		...(provider?.addsSshKeys
			? [
					{
						id: "provider" as const,
						title: `Have ${provider.label} add it`,
						description:
							"For when you can't log in at all. Takes a few minutes.",
					},
				]
			: []),
	];

	return (
		<>
			<DialogHeader>
				<div className="flex items-center gap-3">
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-8 shrink-0"
						onClick={onBack}
					>
						<ArrowLeft className="size-4" />
						<span className="sr-only">Back</span>
					</Button>
					{provider && (
						<CloudProviderIcon
							providerType={provider.type}
							className="size-9 shrink-0"
						/>
					)}
					<div className="flex flex-col gap-1">
						<DialogTitle>Use an existing server</DialogTitle>
						<DialogDescription>
							Pick a server already on your {provider?.label ?? "provider"}{" "}
							account. Dokploy connects to it with an SSH key and installs
							Docker and Traefik.
						</DialogDescription>
					</div>
				</div>
			</DialogHeader>

			<div className="flex flex-col gap-6">
				{accounts.length > 1 && (
					<div className="flex flex-col gap-2">
						<Label>Account</Label>
						<Select
							value={accountId}
							onValueChange={(value) => {
								setAccountId(value);
								setServerId("");
							}}
						>
							<SelectTrigger className="w-full sm:w-80">
								<SelectValue placeholder="Select an account" />
							</SelectTrigger>
							<SelectContent>
								{accounts.map((a) => (
									<SelectItem
										key={a.cloudProviderAccountId}
										value={a.cloudProviderAccountId}
									>
										{providers.find((p) => p.type === a.providerType)?.label} ·{" "}
										{a.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<div className="flex flex-col gap-2">
					<div className="flex items-center justify-between gap-2">
						<Label>Server</Label>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7"
							onClick={() => refetchServers()}
							disabled={isLoadingServers}
						>
							<RefreshCw
								className={cn("size-3.5", isLoadingServers && "animate-spin")}
							/>
							Refresh
						</Button>
					</div>
					{serversError ? (
						<AlertBlock type="error">{serversError.message}</AlertBlock>
					) : isLoadingServers && !servers ? (
						<div className="flex min-h-32 items-center justify-center gap-2 rounded-lg border text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Loading servers from {provider?.label}…
						</div>
					) : sortedServers.length === 0 ? (
						<div className="rounded-lg border px-4 py-6 text-center text-sm text-muted-foreground">
							There are no servers on this account yet.
						</div>
					) : (
						<div className="max-h-60 overflow-y-auto rounded-lg border">
							{sortedServers.map((server) => {
								const reason = unavailableReason(server);
								const isSelected = server.id === serverId;
								return (
									<button
										key={server.id}
										type="button"
										disabled={!!reason}
										onClick={() => selectServer(server)}
										aria-pressed={isSelected}
										className={cn(
											"flex w-full flex-col gap-1 border-b px-4 py-2.5 text-left text-sm transition-colors duration-150 ease-out last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
											isSelected &&
												"bg-primary/5 shadow-[inset_3px_0_0_var(--primary)] hover:bg-primary/5",
										)}
									>
										<span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
											<span className="font-medium">{server.name}</span>
											{server.ipv4 && (
												<span className="font-mono text-xs text-muted-foreground">
													{server.ipv4}
												</span>
											)}
											<span className="text-xs text-muted-foreground">
												{server.serverTypeLabel} · {server.location}
											</span>
										</span>
										<span className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
											{server.cores != null && (
												<span className="flex items-center gap-1">
													<Cpu className="size-3" />
													{server.cores} vCPU
												</span>
											)}
											{server.memoryGb != null && (
												<span className="flex items-center gap-1">
													<MemoryStick className="size-3" />
													{server.memoryGb} GB
												</span>
											)}
											{server.diskGb != null && (
												<span className="flex items-center gap-1">
													<HardDrive className="size-3" />
													{server.diskGb} GB
												</span>
											)}
											{reason && <span>{reason}</span>}
										</span>
									</button>
								);
							})}
						</div>
					)}
				</div>

				{selected && (
					<>
						<div className="grid gap-4 sm:grid-cols-[1fr_auto]">
							<div className="flex flex-col gap-2">
								<Label htmlFor="existing-server-name">Name in Dokploy</Label>
								<Input
									id="existing-server-name"
									value={name}
									autoComplete="off"
									onChange={(e) => setName(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Use as</Label>
								<Tabs
									value={role}
									onValueChange={(value) =>
										setRole(value as "deploy" | "build")
									}
								>
									<TabsList>
										<TabsTrigger value="deploy">Deploy</TabsTrigger>
										<TabsTrigger value="build">Build</TabsTrigger>
									</TabsList>
								</Tabs>
							</div>
						</div>

						<div className="flex flex-col gap-2">
							<Label>SSH key</Label>
							<span className="text-xs text-muted-foreground">
								Dokploy keeps this key and uses it for every connection to the
								server. Create a new one to give this server its own key.
							</span>
							{sshKeysError ? (
								<AlertBlock type="error">{sshKeysError.message}</AlertBlock>
							) : (
								<div className="flex flex-col gap-2 sm:flex-row">
									<Select value={sshKeyId} onValueChange={setSshKeyId}>
										<SelectTrigger className="w-full sm:w-80">
											<SelectValue placeholder="Choose a key" />
										</SelectTrigger>
										<SelectContent>
											{sshKeys?.map((key) => (
												<SelectItem key={key.sshKeyId} value={key.sshKeyId}>
													{key.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<Button
										type="button"
										variant="outline"
										onClick={createKey}
										isLoading={isGenerating}
									>
										<Plus className="size-4" />
										Create a new key
									</Button>
								</div>
							)}
							{selectedKey && (
								<div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2">
									<KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
									<code className="min-w-0 flex-1 break-all text-xs">
										{selectedKey.publicKey.trim()}
									</code>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className="size-6 shrink-0"
										onClick={() => copy(selectedKey.publicKey.trim())}
									>
										<Copy className="size-3.5" />
										<span className="sr-only">Copy public key</span>
									</Button>
								</div>
							)}
						</div>

						<div className="flex flex-col gap-2">
							<Label>How does the key get onto the server?</Label>
							<div
								className={cn(
									"grid gap-2",
									accessOptions.length > 2
										? "sm:grid-cols-3"
										: "sm:grid-cols-2",
								)}
							>
								{accessOptions.map((option) => (
									<button
										key={option.id}
										type="button"
										onClick={() => setAccess(option.id)}
										aria-pressed={access === option.id}
										className={cn(
											"flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:border-foreground/20 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
											access === option.id &&
												"border-primary bg-primary/5 ring-1 ring-primary hover:border-primary hover:bg-primary/5",
										)}
									>
										<span className="text-sm font-medium">{option.title}</span>
										<span className="text-xs text-muted-foreground">
											{option.description}
										</span>
									</button>
								))}
							</div>

							{access === "key" && installCommand && (
								<div className="flex flex-col gap-1.5">
									<span className="text-xs text-muted-foreground">
										Not there yet? Run this on the server as{" "}
										{username || "root"}, then add it:
									</span>
									<div className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2">
										<code className="min-w-0 flex-1 break-all text-xs">
											{installCommand}
										</code>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-6 shrink-0"
											onClick={() => copy(installCommand)}
										>
											<Copy className="size-3.5" />
											<span className="sr-only">Copy command</span>
										</Button>
									</div>
								</div>
							)}
							{access === "password" && (
								<div className="flex flex-col gap-2">
									<Label htmlFor="existing-server-password">
										Password for {username || "root"}
									</Label>
									<div className="sm:w-80">
										<Input
											id="existing-server-password"
											type="password"
											autoComplete="off"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
										/>
									</div>
								</div>
							)}
							{access === "provider" && provider?.addsSshKeys && (
								<AlertBlock type="warning">{provider.addsSshKeys}</AlertBlock>
							)}
						</div>

						<div className="grid gap-4 sm:grid-cols-[1fr_120px]">
							<div className="flex flex-col gap-2">
								<Label htmlFor="existing-server-user">SSH user</Label>
								<Input
									id="existing-server-user"
									value={username}
									autoComplete="off"
									onChange={(e) => setUsername(e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label htmlFor="existing-server-port">Port</Label>
								<Input
									id="existing-server-port"
									type="number"
									min={1}
									max={65535}
									value={port}
									onChange={(e) => setPort(Number(e.target.value) || 22)}
								/>
							</div>
						</div>

						<div className="flex items-start gap-2">
							<Checkbox
								id="existing-server-setup"
								checked={runSetup}
								onCheckedChange={(checked) => setRunSetup(checked === true)}
							/>
							<div className="flex flex-col gap-0.5">
								<Label htmlFor="existing-server-setup">
									Install Docker, Traefik and build tools
								</Label>
								<span className="text-xs text-muted-foreground">
									Turn off if the server is already set up for Dokploy. You can
									run Setup Server later.
								</span>
							</div>
						</div>
					</>
				)}

				<DialogFooter className="sticky -bottom-6 z-10 -mx-6 -mb-6 rounded-b-xl border-t bg-popover px-6 py-4">
					<Button type="button" variant="outline" onClick={onBack}>
						Back
					</Button>
					<Button
						type="button"
						onClick={onSubmit}
						isLoading={isAdding}
						disabled={!canSubmit}
					>
						Add server
					</Button>
				</DialogFooter>
			</div>
		</>
	);
};
