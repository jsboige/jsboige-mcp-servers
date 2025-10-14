import fs from 'fs';

const logPath = 'D:/dev/CoursIA/jupyter-mcp-debug.log';

/**
 * Appends a message to the debug log file.
 * @param message The message to log.
 */
export const log = (message: string): void => {
  try {
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch (error) {
    // Fallback to console if logging to file fails
    console.error(`Failed to write to log file: ${logPath}`, error);
    console.log(`[${new Date().toISOString()}] ${message}`);
  }
};