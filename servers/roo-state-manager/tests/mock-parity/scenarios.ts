/**
 * Scripted scenarios for the mock-parity harness (#1320).
 *
 * Each scenario drives the REAL tool handlers (roosync_dashboard /
 * roosync_messages) — the same code the fleet executes — and returns its
 * result objects for the parity diff. Scenarios must be deterministic modulo
 * the values normalized by trace.ts (timestamps, generated ids, durations).
 *
 * claw-code analog: rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs
 * scripted scenarios, adapted to our GDrive-file-backed tools.
 *
 * @module tests/mock-parity/scenarios
 * @version 1.0.0
 */

import type * as dashboardModule from '../../src/tools/roosync/dashboard.js';
import type * as messagesModule from '../../src/tools/roosync/messages.js';

export interface ToolBundle {
  dashboard: typeof dashboardModule;
  messages: typeof messagesModule;
}

export interface ScenarioOutcome {
  name: string;
  results: unknown[];
}

type Scenario = {
  name: string;
  run: (tools: ToolBundle) => Promise<unknown[]>;
};

const WS = 'parity-ws';

export const SCENARIOS: Scenario[] = [
  {
    name: 'dashboard_write_creates_canonical_file',
    run: async (t) => [
      await t.dashboard.roosyncDashboard({
        action: 'write',
        type: 'workspace',
        workspace: WS,
        content: '# Parity Status\n\nScénario d’écriture mock-parity.',
      }),
    ],
  },
  {
    name: 'dashboard_read_roundtrip_after_write',
    run: async (t) => [
      await t.dashboard.roosyncDashboard({
        action: 'read',
        type: 'workspace',
        workspace: WS,
      }),
    ],
  },
  {
    name: 'dashboard_append_message_visible',
    run: async (t) => [
      await t.dashboard.roosyncDashboard({
        action: 'append',
        type: 'workspace',
        workspace: WS,
        content: 'Message intercom #1 du harness de parité.',
        tags: ['PARITY'],
      }),
      await t.dashboard.roosyncDashboard({
        action: 'read',
        type: 'workspace',
        workspace: WS,
        section: 'intercom',
      }),
    ],
  },
  {
    name: 'dashboard_append_idempotent_same_messageId',
    run: async (t) => {
      const append = (messageId: string) =>
        t.dashboard.roosyncDashboard({
          action: 'append',
          type: 'workspace',
          workspace: WS,
          content: 'Message idempotent mock-parity.',
          messageId,
          tags: ['PARITY'],
        });
      // #3276: same explicit messageId twice → second append deduplicated.
      // The id must satisfy the messageId schema ([A-Za-z0-9._:-]) — no
      // timestamp pattern, so it survives normalization untouched.
      return [await append('parity-dedup-1'), await append('parity-dedup-1')];
    },
  },
  {
    name: 'messages_send_then_inbox_roundtrip',
    run: async (t) => [
      await t.messages.roosyncMessages({
        action: 'send',
        to: 'myia-parity-dest',
        subject: 'Parity roundtrip',
        body: 'Corps du message de test mock-parity.',
        messageId: 'parity-msg-1',
        tags: ['PARITY'],
      }),
      await t.messages.roosyncMessages({
        action: 'inbox',
        to_machine: 'myia-parity-dest',
        format: 'json',
      }),
    ],
  },
];

export async function runAllScenarios(tools: ToolBundle): Promise<ScenarioOutcome[]> {
  const outcomes: ScenarioOutcome[] = [];
  for (const scenario of SCENARIOS) {
    outcomes.push({ name: scenario.name, results: await scenario.run(tools) });
  }
  return outcomes;
}
