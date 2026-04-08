/**
 * Smoke test for roosync_send
 *
 * Purpose: Validate that roosync_send writes fresh data to filesystem
 * Pattern: Issue #564 Phase 2 - Prevent silent bugs from cache staleness (issue #562)
 *
 * @see docs/testing/issue-564-phase1-audit-report.md (lines 162-176)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock getMessageManager to use ROOSYNC_SHARED_PATH env var (real getMessageManager uses require() which fails in vitest ESM)
vi.mock('../../../services/MessageManager.js', async () => {
  const actual = await vi.importActual('../../../services/MessageManager.js') as any;
  return {
    ...actual,
    getMessageManager: () => {
      const sharedPath = process.env.ROOSYNC_SHARED_PATH || os.tmpdir();
      return new actual.MessageManager(sharedPath);
    },
  };
});

import { roosyncSend } from '../send.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('SMOKE: roosync_send', () => {
  const testMessagesPath = path.join(os.tmpdir(), '.test-messages');
  const testSentPath = path.join(testMessagesPath, 'messages', 'sent');
  const testInboxPath = path.join(testMessagesPath, 'messages', 'inbox');
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };

    // Override environment for test isolation
    process.env.ROOSYNC_SHARED_PATH = testMessagesPath;
    process.env.ROOSYNC_MACHINE_ID = 'smoke-test-sender';
    process.env.ROOSYNC_WORKSPACE_ID = 'smoke-test-ws';

    // Create test directory structure (messages/sent, messages/inbox, messages/archive)
    for (const dir of [testSentPath, testInboxPath, path.join(testMessagesPath, 'messages', 'archive')]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;

    // Cleanup test files
    if (fs.existsSync(testMessagesPath)) {
      fs.rmSync(testMessagesPath, { recursive: true, force: true });
    }
  });

  it('should write fresh messages to filesystem (action: send)', async () => {
    // Step 1: Send first message
    const result1 = await roosyncSend({
      action: 'send',
      to: 'test-machine-1',
      subject: 'Test Message 1',
      body: 'First test message body',
      priority: 'MEDIUM'
    });

    expect(result1.content).toBeDefined();
    expect(result1.content[0].type).toBe('text');
    const response1Text = result1.content[0].text;
    expect(response1Text).toContain('Message envoyé avec succès');

    // Extract message ID from response
    const messageId1Match = response1Text.match(/ID\s*:[*\s]*`?([\w-]+)/);
    expect(messageId1Match).toBeTruthy();
    const messageId1 = messageId1Match![1];

    // Step 2: Verify first message was written to sent directory
    const sentFiles1 = fs.readdirSync(testSentPath);
    expect(sentFiles1.length).toBeGreaterThan(0);
    const sentMessage1 = sentFiles1.find(f => f.includes(messageId1));
    expect(sentMessage1).toBeDefined();

    // Step 3: Send second message (state change)
    const result2 = await roosyncSend({
      action: 'send',
      to: 'test-machine-2',
      subject: 'Test Message 2',
      body: 'Second test message body',
      priority: 'HIGH'
    });

    expect(result2.content[0].type).toBe('text');
    const response2Text = result2.content[0].text;

    // Extract second message ID
    const messageId2Match = response2Text.match(/ID\s*:[*\s]*`?([\w-]+)/);
    expect(messageId2Match).toBeTruthy();
    const messageId2 = messageId2Match![1];

    // Step 4: Verify second message has unique ID
    expect(messageId2).not.toBe(messageId1);

    // Step 5: Verify both messages are in sent directory (no stale data)
    const sentFiles2 = fs.readdirSync(testSentPath);
    expect(sentFiles2.length).toBe(2);
    const sentMessage2 = sentFiles2.find(f => f.includes(messageId2));
    expect(sentMessage2).toBeDefined();

    // Verify message content is fresh (read back from disk)
    const message1Path = path.join(testSentPath, sentMessage1!);
    const message1Content = JSON.parse(fs.readFileSync(message1Path, 'utf-8'));
    expect(message1Content.subject).toBe('Test Message 1');
    expect(message1Content.to).toBe('test-machine-1');

    const message2Path = path.join(testSentPath, sentMessage2!);
    const message2Content = JSON.parse(fs.readFileSync(message2Path, 'utf-8'));
    expect(message2Content.subject).toBe('Test Message 2');
    expect(message2Content.to).toBe('test-machine-2');
  });

  it('should write messages to recipient inbox (cross-workspace messaging)', async () => {
    // Step 1: Send message to specific recipient
    const result = await roosyncSend({
      action: 'send',
      to: 'test-machine-1:test-workspace',
      subject: 'Cross-Workspace Message',
      body: 'Testing inbox delivery',
      priority: 'URGENT',
      tags: ['test', 'smoke-test']
    });

    expect(result.content[0].type).toBe('text');
    const responseText = result.content[0].text;

    // Extract message ID
    const messageIdMatch = responseText.match(/ID\s*:[*\s]*`?([\w-]+)/);
    expect(messageIdMatch).toBeTruthy();
    const messageId = messageIdMatch![1];

    // Step 2: Verify message in sent directory
    const sentFiles = fs.readdirSync(testSentPath);
    expect(sentFiles.length).toBe(1);
    expect(sentFiles[0]).toContain(messageId);

    // Step 3: Send second message to same recipient
    const result2 = await roosyncSend({
      action: 'send',
      to: 'test-machine-1:test-workspace',
      subject: 'Second Message',
      body: 'Another message',
      priority: 'LOW'
    });

    const messageId2Match = result2.content[0].text.match(/ID\s*:[*\s]*`?([\w-]+)/);
    const messageId2 = messageId2Match![1];

    // Step 4: Verify second message has different ID
    expect(messageId2).not.toBe(messageId);

    // Step 5: Verify both messages are written (no stale/overwrite)
    const sentFiles2 = fs.readdirSync(testSentPath);
    expect(sentFiles2.length).toBe(2);

    // Verify both messages have correct content
    const messages = sentFiles2.map(f => {
      const content = JSON.parse(fs.readFileSync(path.join(testSentPath, f), 'utf-8'));
      return { id: content.id, subject: content.subject };
    });

    expect(messages).toContainEqual({ id: messageId, subject: 'Cross-Workspace Message' });
    expect(messages).toContainEqual({ id: messageId2, subject: 'Second Message' });
  });

  it('should handle reply action with fresh thread tracking', async () => {
    // Step 1: Create a fake received message from another machine
    // (We can't just send a message and reply to it, because the reply would go
    // back to the original sender which is the local machine - triggering self-message block)
    const initialMessageId = 'msg-fake-initial-for-reply-test';
    const fakeMessage = {
      id: initialMessageId,
      from: 'test-machine-1',
      to: 'smoke-test-sender:smoke-test-ws',
      subject: 'Initial Thread',
      body: 'Starting a conversation',
      priority: 'MEDIUM',
      timestamp: new Date().toISOString(),
      status: 'unread',
      tags: []
    };
    // Write to inbox so MessageManager.getMessage() can find it
    // (getMessage searches inbox, sent, archive - flat structure: messages/inbox/{id}.json)
    fs.writeFileSync(
      path.join(testInboxPath, `${initialMessageId}.json`),
      JSON.stringify(fakeMessage, null, 2)
    );

    // Step 2: Send reply to initial message
    const replyResult = await roosyncSend({
      action: 'reply',
      message_id: initialMessageId,
      body: 'Reply to initial message'
    });

    expect(replyResult.content[0].type).toBe('text');
    const replyText = replyResult.content[0].text;
    expect(replyText).toContain('Réponse envoyée');

    // Extract reply message ID (second ID match - first is the original message ID)
    const replyIdMatches = [...replyText.matchAll(/ID\s*:[*\s]*`?([\w-]+)/g)];
    expect(replyIdMatches.length).toBeGreaterThanOrEqual(2);
    const replyMessageId = replyIdMatches[1][1];

    // Step 3: Verify reply has different ID than original
    expect(replyMessageId).not.toBe(initialMessageId);

    // Step 4: Send second reply
    const reply2Result = await roosyncSend({
      action: 'reply',
      message_id: initialMessageId,
      body: 'Another reply'
    });

    const reply2IdMatches = [...reply2Result.content[0].text.matchAll(/ID\s*:[*\s]*`?([\w-]+)/g)];
    const reply2MessageId = reply2IdMatches[1][1];

    // Step 5: Verify reply messages are in sent directory with fresh content
    const sentFiles = fs.readdirSync(testSentPath);
    expect(sentFiles.length).toBe(2); // 2 replies (initial was a fake received message)

    // Verify thread tracking is fresh (replies reference original message)
    const replyPath = sentFiles.find(f => f.includes(replyMessageId));
    expect(replyPath).toBeDefined();

    const replyContent = JSON.parse(fs.readFileSync(path.join(testSentPath, replyPath!), 'utf-8'));
    expect(replyContent.reply_to).toBe(initialMessageId);

    const reply2Path = sentFiles.find(f => f.includes(reply2MessageId));
    const reply2Content = JSON.parse(fs.readFileSync(path.join(testSentPath, reply2Path!), 'utf-8'));
    expect(reply2Content.reply_to).toBe(initialMessageId);
  });
});
