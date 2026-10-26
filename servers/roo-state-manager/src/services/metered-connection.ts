/**
 * Metered-connection guard for background indexing.
 *
 * Third bandwidth leak (26/10): a laptop on a phone hotspot (Orange mobile,
 * 92.184.x.x in the IIS logs of po-2023) ran Worker B over the billed link —
 * 644 MB of Qdrant upserts and 232 MB of embeddings between 09:09Z and 10:59Z.
 * The `ROO_INDEXING_ENABLED` kill-switch (#985) is read once at boot and set by
 * hand per machine, so it cannot follow a machine that moves from fibre to a
 * hotspot. This probe asks Windows for the cost of the current internet profile
 * (WinRT `NetworkInformation`, the same signal Windows Update and OneDrive obey)
 * so Worker B pauses while the link is metered and resumes when it is not.
 *
 * The cost alone misses a phone shared over USB: po-2027 measured the leak on a
 * "SAMSUNG Mobile USB Remote NDIS Network Device" (19 GiB received), a plain
 * Ethernet link to Windows. The probe therefore also reports the adapter
 * description, and a USB-tether adapter counts as metered whatever its cost.
 *
 * Fail-open: a probe that cannot answer leaves indexing on, as before this guard
 * existed — a broken probe must not silently stop indexing on every machine.
 */
import { execFile } from 'child_process';

export interface ConnectionCost {
	costType: string;
	roaming: boolean;
	approachingDataLimit: boolean;
	overDataLimit: boolean;
	adapterDescription: string;
	profileName: string;
}

/** Phone shared over USB (Android RNDIS, iPhone): billed, whatever cost Windows reports. */
export const USB_TETHER_ADAPTER = /Remote NDIS|Apple Mobile Device Ethernet/i;

/** Re-probe at most once per Worker B tick (the tick is 5 min). */
export const METERED_CHECK_TTL_MS = 4 * 60 * 1000;

// Windows PowerShell 5.1 only: the WinRT type accelerator does not exist in pwsh 7.
export const PROBE_SCRIPT = [
	'$null=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]',
	'$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
	'if(-not $p){"NONE"}else{$c=$p.GetConnectionCost()',
	'$a=Get-NetAdapter -ErrorAction SilentlyContinue|Where-Object{[guid]$_.InterfaceGuid -eq $p.NetworkAdapter.NetworkAdapterId}|Select-Object -First 1',
	'$d=if($a){$a.InterfaceDescription -replace \'\\|\',\'/\'}else{\'\'}',
	'"{0}|{1}|{2}|{3}|{4}|{5}" -f $c.NetworkCostType,$c.Roaming,$c.ApproachingDataLimit,$c.OverDataLimit,$d,$p.ProfileName}',
].join(';');

/**
 * Parses the probe's last output line, `Cost|Roaming|Approaching|Over|Adapter|Profile`.
 * The profile name comes last because it may contain the separator.
 * `null` = no internet profile, or output that is not the probe's format.
 */
export function parseConnectionCost(stdout: string): ConnectionCost | null {
	const line = stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
	const parts = line.split('|');
	if (parts.length < 6 || !parts[0]) return null;
	const flag = (v: string) => v.trim().toLowerCase() === 'true';
	return {
		costType: parts[0].trim(),
		roaming: flag(parts[1]),
		approachingDataLimit: flag(parts[2]),
		overDataLimit: flag(parts[3]),
		adapterDescription: parts[4].trim(),
		profileName: parts.slice(5).join('|').trim(),
	};
}

/**
 * `Fixed` and `Variable` are billed by volume; roaming, data-limit flags and a
 * USB-tether adapter are too.
 * `Unknown` stays unmetered on purpose: a desktop seat answering Unknown would
 * otherwise stop indexing fleet-wide, silently, while every link is fibre.
 */
export function isMeteredCost(cost: ConnectionCost | null): boolean {
	if (!cost) return false;
	return cost.costType === 'Fixed'
		|| cost.costType === 'Variable'
		|| cost.roaming
		|| cost.approachingDataLimit
		|| cost.overDataLimit
		|| USB_TETHER_ADAPTER.test(cost.adapterDescription);
}

export interface MeteredProbeDeps {
	platform: NodeJS.Platform;
	env: NodeJS.ProcessEnv;
	now: () => number;
	runProbe: () => Promise<string>;
}

/** The production probe: raw stdout of the WinRT cost query (Windows only). */
export function runPowerShellProbe(): Promise<string> {
	return new Promise((resolveOut, reject) => {
		execFile(
			'powershell.exe',
			['-NoProfile', '-NonInteractive', '-Command', PROBE_SCRIPT],
			{ timeout: 15_000, windowsHide: true },
			(err, stdout) => (err ? reject(err) : resolveOut(String(stdout))),
		);
	});
}

let cache: { at: number; metered: boolean } | null = null;

/** Test hook: forget the cached verdict. */
export function resetMeteredConnectionCache(): void {
	cache = null;
}

/**
 * True while Windows reports the internet profile as metered. Always false off
 * Windows, and when `ROO_INDEXING_ON_METERED=true` opts the machine back in.
 */
export async function isMeteredConnection(deps: Partial<MeteredProbeDeps> = {}): Promise<boolean> {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const now = deps.now ?? Date.now;
	const runProbe = deps.runProbe ?? runPowerShellProbe;

	if ((env.ROO_INDEXING_ON_METERED ?? '').trim().toLowerCase() === 'true') return false;
	if (platform !== 'win32') return false;
	if (cache && now() - cache.at < METERED_CHECK_TTL_MS) return cache.metered;

	let metered = false;
	let cost: ConnectionCost | null = null;
	try {
		cost = parseConnectionCost(await runProbe());
		metered = isMeteredCost(cost);
	} catch (error: any) {
		console.warn(`[Metered-Guard] Connection cost probe failed — indexing stays on (fail-open): ${error?.message || error}`);
	}
	if (cache?.metered !== metered) {
		console.log(metered
			? `📵 [Metered-Guard] Metered connection (${cost?.costType}, profile "${cost?.profileName}", adapter "${cost?.adapterDescription}") — background indexing paused`
			: `[Metered-Guard] Unmetered connection${cost ? ` (${cost.costType}, profile "${cost.profileName}")` : ''} — background indexing allowed`);
	}
	cache = { at: now(), metered };
	return metered;
}
