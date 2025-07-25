import openai from './openai.js';
import fs from 'fs/promises';
import path from 'path';

interface TaskDetails {
  objective: string;
  tools_used: string[];
  files_modified: string[];
  final_outcome: string;
}

export async function extractTaskDetails(taskId: string, taskPath: string): Promise<TaskDetails | null> {
  try {
    const historyPath = path.join(taskPath, 'history.json');
    const historyContent = await fs.readFile(historyPath, 'utf-8');
    const conversation = JSON.parse(historyContent);

    // Simplistic concatenation for now. We can improve this.
    const fullConversation = conversation.map((entry: any) => entry.content).join('\n');

    const systemPrompt = `
      You are an expert at analyzing software development conversation histories.
      Your task is to extract key details from the following conversation and return them as a structured JSON object.
      The JSON object must have the following keys: "objective", "tools_used", "files_modified", and "final_outcome".
      - "objective": A clear and concise description of the main goal of the task.
      - "tools_used": An array of strings listing the tools used to complete the task.
      - "files_modified": An array of strings listing the relative paths of the files that were created or modified.
      - "final_outcome": A summary of the final result or state of the task.
    `;

    const response = await openai.chat.completions.create({
      model: 'gpt-4-turbo',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: fullConversation,
        },
      ],
      response_format: { type: 'json_object' },
    });

    if (response.choices[0].message.content) {
      const details = JSON.parse(response.choices[0].message.content) as TaskDetails;
      return details;
    }

    return null;
  } catch (error) {
    console.error(`[TaskDetailsExtractor] Error extracting details for task ${taskId}:`, error);
    if (error instanceof SyntaxError) {
      console.error("Failed to parse the response from OpenAI as JSON.");
    }
    return null;
  }
}