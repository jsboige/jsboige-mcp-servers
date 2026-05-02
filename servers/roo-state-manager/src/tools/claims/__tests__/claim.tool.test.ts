/**
 * Tests for claim.tool.ts — Pre-claim enforcement (#1836)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const { mockGetSharedStatePath } = vi.hoisted(() => ({
	mockGetSharedStatePath: vi.fn()
}));

const { mockGetLocalMachineId } = vi.hoisted(() => ({
	mockGetLocalMachineId: vi.fn()
}));

vi.mock('../../../utils/shared-state-path.js', () => ({
	getSharedStatePath: mockGetSharedStatePath
}));

vi.mock('../../../utils/message-helpers.js', () => ({
	getLocalMachineId: mockGetLocalMachineId
}));

vi.mock('../../../utils/logger.js', () => ({
	createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
	Logger: class {}
}));

vi.mock('../../roosync/heartbeat-activity.js', () => ({
	recordRooSyncActivityAsync: vi.fn()
}));

import { handleClaimTool, ClaimToolArgsSchema } from '../claim.tool.js';

describe('claim.tool', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claim-test-'));
		mockGetSharedStatePath.mockReturnValue(tmpDir);
		mockGetLocalMachineId.mockReturnValue('test-machine');
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	});

	// ============================================================
	// Schema validation
	// ============================================================

	describe('schema', () => {
		test('requires action', () => {
			const result = ClaimToolArgsSchema.safeParse({});
			expect(result.success).toBe(false);
		});

		test('claim requires issue_number and eta_minutes', () => {
			const result = ClaimToolArgsSchema.safeParse({ action: 'claim' });
			expect(result.success).toBe(false);
		});

		test('valid claim args pass', () => {
			const result = ClaimToolArgsSchema.safeParse({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});
			expect(result.success).toBe(true);
		});

		test('check requires issue_number', () => {
			const result = ClaimToolArgsSchema.safeParse({ action: 'check' });
			expect(result.success).toBe(false);
		});

		test('release requires claim_id or issue_number', () => {
			const result = ClaimToolArgsSchema.safeParse({ action: 'release' });
			expect(result.success).toBe(false);
		});

		test('extend requires claim_id or issue_number and additional_minutes', () => {
			const result = ClaimToolArgsSchema.safeParse({ action: 'extend' });
			expect(result.success).toBe(false);
		});

		test('list requires no extra params', () => {
			const result = ClaimToolArgsSchema.safeParse({ action: 'list' });
			expect(result.success).toBe(true);
		});
	});

	// ============================================================
	// Claim action
	// ============================================================

	describe('claim', () => {
		test('creates a claim successfully', async () => {
			const result = await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('claimed');
			expect(data.issue_number).toBe('1836');
			expect(data.claim_id).toMatch(/^claim-/);
			expect(result.isError).toBeFalsy();

			// Verify file was written
			const claimsPath = path.join(tmpDir, 'claims', 'active-claims.json');
			const file = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			expect(file.claims).toHaveLength(1);
			expect(file.claims[0].issue_number).toBe('1836');
			expect(file.claims[0].status).toBe('active');
		});

		test('conflicts on double-claim', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const result = await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 60,
				agent: 'other-machine'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('conflict');
			expect(data.claim.claimed_by).toBe('test-machine');
			expect(result.isError).toBe(true);
		});

		test('uses provided agent name', async () => {
			const result = await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30,
				agent: 'custom-agent'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.claim_id).toContain('custom-agent');
		});

		test('stores branch if provided', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30,
				branch: 'wt/1836-claim-api'
			});

			const claimsPath = path.join(tmpDir, 'claims', 'active-claims.json');
			const file = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			expect(file.claims[0].branch).toBe('wt/1836-claim-api');
		});

		test('sets expiry to eta_minutes * 1.5', async () => {
			const before = Date.now();
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const claimsPath = path.join(tmpDir, 'claims', 'active-claims.json');
			const file = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			const expiresAt = new Date(file.claims[0].expires_at).getTime();
			const startedAt = new Date(file.claims[0].started_at).getTime();
			const diffMinutes = (expiresAt - startedAt) / 60000;
			expect(diffMinutes).toBe(45); // 30 * 1.5
		});
	});

	// ============================================================
	// Check action
	// ============================================================

	describe('check', () => {
		test('returns available when not claimed', async () => {
			const result = await handleClaimTool({
				action: 'check',
				issue_number: '1836'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('available');
			expect(data.issue_number).toBe('1836');
		});

		test('returns claimed when active claim exists', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const result = await handleClaimTool({
				action: 'check',
				issue_number: '1836'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('claimed');
			expect(data.claim.claimed_by).toBe('test-machine');
			expect(data.claim.started_ago_minutes).toBeGreaterThanOrEqual(0);
		});
	});

	// ============================================================
	// Release action
	// ============================================================

	describe('release', () => {
		test('releases by claim_id', async () => {
			const claimResult = await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});
			const claimId = JSON.parse(claimResult.content[0].text as string).claim_id;

			const result = await handleClaimTool({
				action: 'release',
				claim_id: claimId
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('released');
			expect(data.issue_number).toBe('1836');
		});

		test('releases by issue_number', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const result = await handleClaimTool({
				action: 'release',
				issue_number: '1836'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('released');
		});

		test('returns not_found for unknown claim_id', async () => {
			const result = await handleClaimTool({
				action: 'release',
				claim_id: 'claim-nonexistent'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('not_found');
		});

		test('allows re-claim after release', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});
			await handleClaimTool({
				action: 'release',
				issue_number: '1836'
			});

			const result = await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 60
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('claimed');
		});
	});

	// ============================================================
	// Extend action
	// ============================================================

	describe('extend', () => {
		test('extends a claim by additional_minutes', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const result = await handleClaimTool({
				action: 'extend',
				issue_number: '1836',
				additional_minutes: 20
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('extended');
			expect(data.total_eta_minutes).toBe(50);
		});

		test('updates expires_at when extending', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			const claimsPath = path.join(tmpDir, 'claims', 'active-claims.json');
			const before = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			const oldExpiry = new Date(before.claims[0].expires_at);

			await handleClaimTool({
				action: 'extend',
				issue_number: '1836',
				additional_minutes: 15
			});

			const after = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			const newExpiry = new Date(after.claims[0].expires_at);
			expect(newExpiry.getTime()).toBeGreaterThan(oldExpiry.getTime());
		});

		test('returns not_found for non-active claim', async () => {
			const result = await handleClaimTool({
				action: 'extend',
				issue_number: '9999',
				additional_minutes: 10
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('not_found');
		});
	});

	// ============================================================
	// List action
	// ============================================================

	describe('list', () => {
		test('returns empty when no claims', async () => {
			const result = await handleClaimTool({
				action: 'list'
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('ok');
			expect(data.count).toBe(0);
			expect(data.claims).toEqual([]);
		});

		test('lists active claims', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});
			await handleClaimTool({
				action: 'claim',
				issue_number: '1837',
				eta_minutes: 45,
				agent: 'other-machine'
			});

			const result = await handleClaimTool({ action: 'list' });
			const data = JSON.parse(result.content[0].text as string);
			expect(data.count).toBe(2);
			expect(data.claims[0].issue_number).toBe('1836');
			expect(data.claims[1].issue_number).toBe('1837');
		});

		test('excludes released claims from list', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});
			await handleClaimTool({
				action: 'claim',
				issue_number: '1837',
				eta_minutes: 45
			});
			await handleClaimTool({
				action: 'release',
				issue_number: '1836'
			});

			const result = await handleClaimTool({ action: 'list' });
			const data = JSON.parse(result.content[0].text as string);
			expect(data.count).toBe(1);
			expect(data.claims[0].issue_number).toBe('1837');
		});
	});

	// ============================================================
	// Auto-expiry
	// ============================================================

	describe('auto-expiry', () => {
		test('expired claims are marked on read', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			// Manually expire the claim
			const claimsPath = path.join(tmpDir, 'claims', 'active-claims.json');
			const file = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			file.claims[0].expires_at = new Date(Date.now() - 10000).toISOString();
			await fs.writeFile(claimsPath, JSON.stringify(file, null, 2));

			const result = await handleClaimTool({ action: 'list' });
			const data = JSON.parse(result.content[0].text as string);
			expect(data.count).toBe(0);
		});

		test('expired claim allows re-claim', async () => {
			await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 30
			});

			// Manually expire
			const claimsPath = path.join(tmpDir, 'claims', 'active-claims.json');
			const file = JSON.parse(await fs.readFile(claimsPath, 'utf-8'));
			file.claims[0].expires_at = new Date(Date.now() - 10000).toISOString();
			await fs.writeFile(claimsPath, JSON.stringify(file, null, 2));

			const result = await handleClaimTool({
				action: 'claim',
				issue_number: '1836',
				eta_minutes: 60
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('claimed');
		});
	});

	// ============================================================
	// Error handling
	// ============================================================

	describe('error handling', () => {
		test('returns error for unknown action', async () => {
			const result = await handleClaimTool({
				action: 'unknown' as any
			});

			const data = JSON.parse(result.content[0].text as string);
			expect(data.status).toBe('error');
			expect(data.message).toContain('Unknown action');
		});
	});
});
