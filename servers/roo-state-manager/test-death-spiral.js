/**
 * Simple verification test for DeathSpiralDetector
 * This test doesn't require external services
 */

import { DeathSpiralDetector } from './src/services/death-spiral-detector.js';
import { ConversationSkeleton } from './src/types/conversation.js';

// Create a mock conversation cache
const mockConversationCache = new Map<string, ConversationSkeleton>();

// Create a mock task with high error ratio (should be detected as death spiral)
const mockGarbageTask: ConversationSkeleton = {
  taskId: 'task-garbage-001',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Error: 502 Bad Gateway'
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '' // Empty output
        }
      ]
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Error: timeout'
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: '' // Empty output
        }
      ]
    }
  ],
  metadata: {
    totalSize: 100000 // 100KB
  }
};

// Create a normal task
const mockNormalTask: ConversationSkeleton = {
  taskId: 'task-normal-001',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Hello world'
        }
      ]
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Hello! How can I help you today?'
        }
      ]
    }
  ],
  metadata: {
    totalSize: 5000 // 5KB
  }
};

// Add tasks to cache
mockConversationCache.set('task-garbage-001', mockGarbageTask);
mockConversationCache.set('task-normal-001', mockNormalTask);

// Test the DeathSpiralDetector
async function testDeathSpiralDetector() {
  console.log('🧪 Testing DeathSpiralDetector...');

  try {
    const analysis = await DeathSpiralDetector.analyzeTasksForDeathSpiral(
      ['task-garbage-001', 'task-normal-001'],
      mockConversationCache
    );

    console.log('\n📊 Results:');
    console.log(`Death spirals detected: ${analysis.deathSpirals.length}`);
    console.log(`Tasks at risk: ${analysis.tasksAtRisk.length}`);

    if (analysis.deathSpirals.length > 0) {
      console.log('\n🚨 Death Spiral Found:');
      console.log(`Task: ${analysis.deathSpirals[0].taskId}`);
      console.log(`Risk Level: ${analysis.deathSpirals[0].riskLevel}`);
      console.log(`Error Ratio: ${(analysis.deathSpirals[0].errorRatio * 100).toFixed(1)}%`);
      console.log(`Assistant Output Ratio: ${(analysis.deathSpirals[0].assistantOutputRatio * 100).toFixed(1)}%`);
    }

    if (analysis.tasksAtRisk.length > 0) {
      console.log('\n⚠️ Tasks at Risk:');
      analysis.tasksAtRisk.forEach(task => {
        console.log(`- ${task.taskId}: ${task.riskFactors.join(', ')}`);
      });
    }

    console.log('\n✅ DeathSpiralDetector test completed successfully!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  }
}

// Run the test
testDeathSpiralDetector();