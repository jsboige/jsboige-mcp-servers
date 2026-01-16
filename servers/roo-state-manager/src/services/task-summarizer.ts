// import * as fs from 'fs/promises';
// import * as path from 'path';
// import openai from './openai.js';
import { GenericError, GenericErrorCode } from '../types/errors.js';

// interface Message {
//   role: 'user' | 'assistant';
//   content: string;
// }

// interface Conversation {
//   messages: Message[];
// }

// export async function summarizeTask(taskId: string, taskPath: string): Promise<string> {
//   const messagesJsonPath = path.join(taskPath, 'messages.json');
//
//   try {
//     const fileContent = await fs.readFile(messagesJsonPath, 'utf-8');
//     const conversation: Conversation = JSON.parse(fileContent);
//
//     const conversationText = conversation.messages
//       .filter(msg => msg.role === 'user' || msg.role === 'assistant')
//       .map(msg => `${msg.role}: ${msg.content}`)
//       .join('\n');
//
//     if (!conversationText) {
//       return 'Impossible de générer un résumé : la conversation est vide.';
//     }
//
//     const response = await openai.chat.completions.create({
//       model: 'gpt-4-turbo',
//       messages: [
//         {
//           role: 'system',
//           content: "Résume la conversation suivante en 3 phrases maximum, en te concentrant sur l'objectif initial, les actions principales et le résultat final. Le résumé doit être en français.",
//         },
//         {
//           role: 'user',
//           content: conversationText,
//         },
//       ],
//       temperature: 0.2,
//       max_tokens: 150,
//     });
//
//     const summary = response.choices[0].message.content?.trim() ?? 'Résumé non disponible.';
//     return summary;
//
//   } catch (error) {
//     if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
//         throw new GenericError(`Fichier messages.json non trouvé pour la tâche ${taskId}`, GenericErrorCode.FILE_SYSTEM_ERROR);
//     }
//     console.error(`Erreur lors du résumé de la tâche ${taskId}:`, error);
//     throw new GenericError(`Impossible de générer le résumé pour la tâche ${taskId}.`, GenericErrorCode.FILE_SYSTEM_ERROR);
//   }
// }
