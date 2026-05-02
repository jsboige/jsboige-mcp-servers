/**
 * MCP tool: roosync_claim
 *
 * Pre-claim enforcement — prevents concurrent agent collisions.
 * Actions: claim, release, extend, list, check.
 *
 * Claims are stored in {sharedPath}/claims/active-claims.json.
 * Auto-expire after eta_minutes * 1.5.
 *
 * @module tools/claims
 * @version 1.0.0
 * @issue #1836
 */

import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger, type Logger } from '../../utils/logger.js';
import { getLocalMachineId } from '../../utils/message-helpers.js';
import { getSharedStatePath } from '../../utils/shared-state-path.js';
import { recordRooSyncActivityAsync } from '../roosync/heartbeat-activity.js';

const logger: Logger = createLogger('ClaimTool');

// ============================================================
// Types
// ============================================================

interface Claim {
	id: string;
	issue_number: string;
	agent: string;
	workspace: string;
	started_at: string;
	eta_minutes: number;
	expires_at: string;
	status: 'active' | 'released' | 'expired';
	branch?: string;
	pr_url?: string;
}

interface ClaimsFile {
	claims: Claim[];
	last_updated: string;
}

// ============================================================
// Schema
// ============================================================

export const ClaimToolArgsSchema = z.object({
	action: z.enum(['claim', 'release', 'extend', 'list', 'check']).describe(
		'Action: "claim" (reserve issue), "release" (free claim), "extend" (prolong), "list" (active claims), "check" (verify issue status)'
	),
	issue_number: z.string().describe(
		'Issue number (e.g., "1836"). Required for claim/check/release/extend.'
	).optional(),
	agent: z.string().describe(
		'Agent identifier (machine ID). Defaults to local machine.'
	).optional(),
	eta_minutes: z.number().describe(
		'Estimated time in minutes. Required for claim, optional for extend.'
	).optional(),
	branch: z.string().describe(
		'Git branch name for the claim (optional).'
	).optional(),
	claim_id: z.string().describe(
		'Claim ID. Required for release/extend.'
	).optional(),
	additional_minutes: z.number().describe(
		'Additional minutes for extend action.'
	).optional(),
}).superRefine((data, ctx) => {
	if ((data.action === 'claim' || data.action === 'check') && !data.issue_number) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'issue_number is required for claim and check actions', path: ['issue_number'] });
	}
	if ((data.action === 'release' || data.action === 'extend') && !data.claim_id && !data.issue_number) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'claim_id or issue_number is required for release/extend actions', path: ['claim_id'] });
	}
	if (data.action === 'claim' && !data.eta_minutes) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'eta_minutes is required for claim action', path: ['eta_minutes'] });
	}
	if (data.action === 'extend' && !data.additional_minutes) {
		ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'additional_minutes is required for extend action', path: ['additional_minutes'] });
	}
});

export type ClaimToolArgs = z.infer<typeof ClaimToolArgsSchema>;

// ============================================================
// Storage
// ============================================================

function getClaimsFilePath(): string {
	const sharedPath = getSharedStatePath();
	return path.join(sharedPath, 'claims', 'active-claims.json');
}

async function readClaims(): Promise<ClaimsFile> {
	const filePath = getClaimsFilePath();
	try {
		const raw = await fs.readFile(filePath, 'utf-8');
		return JSON.parse(raw);
	} catch {
		return { claims: [], last_updated: new Date().toISOString() };
	}
}

async function writeClaims(data: ClaimsFile): Promise<void> {
	const filePath = getClaimsFilePath();
	const dir = path.dirname(filePath);
	await fs.mkdir(dir, { recursive: true });
	data.last_updated = new Date().toISOString();
	await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function expireOldClaims(claims: Claim[]): Claim[] {
	const now = new Date();
	return claims.map(c => {
		if (c.status === 'active' && new Date(c.expires_at) < now) {
			return { ...c, status: 'expired' as const };
		}
		return c;
	});
}

function generateClaimId(agent: string): string {
	const now = new Date();
	const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 15);
	return `claim-${ts}-${agent}`;
}

// ============================================================
// Handlers
// ============================================================

async function handleClaim(args: ClaimToolArgs): Promise<string> {
	const agent = args.agent || getLocalMachineId();
	const issueNumber = args.issue_number!;
	const etaMinutes = args.eta_minutes!;

	let data = await readClaims();
	data.claims = expireOldClaims(data.claims);

	// Check for existing active claim
	const existing = data.claims.find(
		c => c.issue_number === issueNumber && c.status === 'active'
	);

	if (existing) {
		const startedAgo = Math.round((Date.now() - new Date(existing.started_at).getTime()) / 60000);
		return JSON.stringify({
			status: 'conflict',
			message: `Issue #${issueNumber} is already claimed`,
			claim: {
				claimed_by: existing.agent,
				claim_id: existing.id,
				started_at: existing.started_at,
				eta_minutes: existing.eta_minutes,
				started_ago_minutes: startedAgo,
				expires_at: existing.expires_at,
				branch: existing.branch,
			},
			action: 'STOP — do not work on this issue. Contact coordinator for arbitration.',
		});
	}

	// Create new claim
	const now = new Date();
	const expiresAt = new Date(now.getTime() + etaMinutes * 1.5 * 60000);
	const claim: Claim = {
		id: generateClaimId(agent),
		issue_number: issueNumber,
		agent,
		workspace: process.env.ROOSYNC_MACHINE_ID || 'unknown',
		started_at: now.toISOString(),
		eta_minutes: etaMinutes,
		expires_at: expiresAt.toISOString(),
		status: 'active',
		branch: args.branch,
	};

	data.claims.push(claim);
	await writeClaims(data);

	recordRooSyncActivityAsync('claim_created');

	logger.info(`Claim created: ${claim.id} for #${issueNumber} by ${agent}`);
	return JSON.stringify({
		status: 'claimed',
		claim_id: claim.id,
		issue_number: issueNumber,
		expires_at: claim.expires_at,
		message: `Issue #${issueNumber} claimed by ${agent}. Post [CLAIMED] to dashboard with this claim_id.`,
	});
}

async function handleRelease(args: ClaimToolArgs): Promise<string> {
	let data = await readClaims();
	data.claims = expireOldClaims(data.claims);

	const claim = data.claims.find(c => {
		if (args.claim_id) return c.id === args.claim_id;
		if (args.issue_number) return c.issue_number === args.issue_number && c.status === 'active';
		return false;
	});

	if (!claim) {
		return JSON.stringify({
			status: 'not_found',
			message: args.claim_id
				? `Claim ${args.claim_id} not found`
				: `No active claim for issue #${args.issue_number}`,
		});
	}

	claim.status = 'released';
	await writeClaims(data);

	logger.info(`Claim released: ${claim.id} for #${claim.issue_number}`);
	return JSON.stringify({
		status: 'released',
		claim_id: claim.id,
		issue_number: claim.issue_number,
		message: `Claim released for issue #${claim.issue_number}`,
	});
}

async function handleExtend(args: ClaimToolArgs): Promise<string> {
	const additionalMinutes = args.additional_minutes!;

	let data = await readClaims();
	data.claims = expireOldClaims(data.claims);

	const claim = data.claims.find(c => {
		if (args.claim_id) return c.id === args.claim_id && c.status === 'active';
		if (args.issue_number) return c.issue_number === args.issue_number && c.status === 'active';
		return false;
	});

	if (!claim) {
		return JSON.stringify({
			status: 'not_found',
			message: args.claim_id
				? `Active claim ${args.claim_id} not found`
				: `No active claim for issue #${args.issue_number}`,
		});
	}

	const newExpiry = new Date(new Date(claim.expires_at).getTime() + additionalMinutes * 60000);
	claim.expires_at = newExpiry.toISOString();
	claim.eta_minutes += additionalMinutes;

	await writeClaims(data);

	logger.info(`Claim extended: ${claim.id}, +${additionalMinutes}min`);
	return JSON.stringify({
		status: 'extended',
		claim_id: claim.id,
		issue_number: claim.issue_number,
		new_expires_at: claim.expires_at,
		total_eta_minutes: claim.eta_minutes,
		message: `Claim extended by ${additionalMinutes} minutes`,
	});
}

async function handleList(args: ClaimToolArgs): Promise<string> {
	let data = await readClaims();
	data.claims = expireOldClaims(data.claims);

	// Persist expiry updates
	await writeClaims(data);

	const activeClaims = data.claims.filter(c => c.status === 'active');

	if (activeClaims.length === 0) {
		return JSON.stringify({
			status: 'ok',
			count: 0,
			claims: [],
			message: 'No active claims',
		});
	}

	return JSON.stringify({
		status: 'ok',
		count: activeClaims.length,
		claims: activeClaims.map(c => ({
			claim_id: c.id,
			issue_number: c.issue_number,
			agent: c.agent,
			started_at: c.started_at,
			eta_minutes: c.eta_minutes,
			expires_at: c.expires_at,
			branch: c.branch,
		})),
	});
}

async function handleCheck(args: ClaimToolArgs): Promise<string> {
	const issueNumber = args.issue_number!;

	let data = await readClaims();
	data.claims = expireOldClaims(data.claims);

	const claim = data.claims.find(
		c => c.issue_number === issueNumber && c.status === 'active'
	);

	if (!claim) {
		return JSON.stringify({
			status: 'available',
			issue_number: issueNumber,
			message: `Issue #${issueNumber} is not claimed`,
		});
	}

	const startedAgo = Math.round((Date.now() - new Date(claim.started_at).getTime()) / 60000);
	return JSON.stringify({
		status: 'claimed',
		issue_number: issueNumber,
		claim: {
			claimed_by: claim.agent,
			claim_id: claim.id,
			started_at: claim.started_at,
			started_ago_minutes: startedAgo,
			eta_minutes: claim.eta_minutes,
			expires_at: claim.expires_at,
			branch: claim.branch,
		},
	});
}

// ============================================================
// Main handler
// ============================================================

export async function handleClaimTool(args: ClaimToolArgs): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	try {
		let result: string;

		switch (args.action) {
			case 'claim':
				result = await handleClaim(args);
				break;
			case 'release':
				result = await handleRelease(args);
				break;
			case 'extend':
				result = await handleExtend(args);
				break;
			case 'list':
				result = await handleList(args);
				break;
			case 'check':
				result = await handleCheck(args);
				break;
			default:
				result = JSON.stringify({ status: 'error', message: `Unknown action: ${args.action}` });
		}

		// Conflict (double-claim) returns isError so agents can detect it
		const parsed = JSON.parse(result);
		const isError = parsed.status === 'conflict';

		return {
			content: [{ type: 'text' as const, text: result }],
			...(isError ? { isError: true } : {}),
		};
	} catch (error: any) {
		logger.error(`Claim tool error: ${error.message}`);
		return {
			content: [{ type: 'text' as const, text: JSON.stringify({ status: 'error', message: error.message }) }],
			isError: true,
		};
	}
}
