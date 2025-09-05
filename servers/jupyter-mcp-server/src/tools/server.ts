import { spawn, ChildProcess, exec } from 'child_process';
import { initializeJupyterServices } from '../services/jupyter.js';

type ToolSchema = {
  type: string;
  properties: Record<string, any>;
  required?: string[];
};

let jupyterServerProcess: ChildProcess | null = null;

const cleanupOrphanedJupyterProcesses = (log) => {
    return new Promise<void>((resolve) => {
        log('Cleaning up any orphaned Jupyter processes...');
        exec('taskkill /F /IM jupyter-lab.exe /T', (error, stdout, stderr) => {
            if (error && !error.message.includes('not found')) {
                log(`Error killing Jupyter processes: ${stderr}`);
            } else {
                log('Cleanup successful.');
            }
            resolve();
        });
    });
};

const startJupyterServerSchema: ToolSchema = {
  type: 'object',
  properties: {
    envPath: {
        type: 'string',
        description: "Chemin vers l'exécutable jupyter-lab.exe dans l'environnement Conda (ou autre)."
    }
  },
  required: ['envPath']
};

export const serverTools = [
  {
    name: 'start_jupyter_server',
    description: "Démarre un serveur Jupyter Lab et le connecte au MCP.",
    schema: startJupyterServerSchema,
    handler: async ({ envPath }) => {
      const logPath = 'D:/dev/CoursIA/jupyter-mcp-debug.log';
      const log = (message) => require('fs').appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);

      log('--- start_jupyter_server handler called ---');
      log(`envPath: ${envPath}`);
      
      await cleanupOrphanedJupyterProcesses(log);

      return new Promise((resolve, reject) => {
        try {
          log('Spawning Jupyter process with token authentication disabled...');
          const jupyterProcess = spawn(
            envPath,
            ['--no-browser', '--ServerApp.disable_check_xsrf=True', '--LabApp.token=\'\''],
            { stdio: ['ignore', 'pipe', 'pipe'] }
          );
          jupyterServerProcess = jupyterProcess;
          log(`Jupyter process spawned with PID: ${jupyterProcess.pid}`);

          let stderr = '';
          jupyterProcess.stderr.on('data', (data) => {
            stderr += data.toString();
            log(`stderr: ${data.toString()}`);
          });
 
          const os = require('os');
          const path = require('path');
          const fs = require('fs');
 
          const homeDir = os.homedir();
          const runtimeDir = path.join(homeDir, 'AppData', 'Roaming', 'jupyter', 'runtime');
          log(`os.homedir() resolved to: ${homeDir}`);
          log(`Polling for server file in directory: ${runtimeDir}`);
  
          const checkServerFile = async () => {
            try {
              if (!fs.existsSync(runtimeDir)) {
                  log(`Runtime directory does not exist: ${runtimeDir}`);
                  return false;
              }
              const runtimeFiles = fs.readdirSync(runtimeDir);
              log(`Files in runtime dir: [${runtimeFiles.join(', ')}]`);
              const serverFileRegex = /^jpserver-(\d+)\.json$/;
              const serverFile = runtimeFiles.find(f => serverFileRegex.test(f));
              
              if (serverFile) {
                log(`Found server file: ${serverFile}`);
                const serverInfo = JSON.parse(fs.readFileSync(path.join(runtimeDir, serverFile), 'utf-8'));
                const baseUrl = serverInfo.url;

                const token = ''; // No token needed
                log(`Initializing Jupyter services with baseUrl: ${baseUrl} and an empty token.`);
                await initializeJupyterServices({ baseUrl, token });
                log('Jupyter services initialized successfully.');
                
                resolve({
                  status: 'started',
                  pid: jupyterProcess.pid,
                  baseUrl: baseUrl,
                  token: token,
                });
                return true;
              } else {
                 log('Server file not found yet.');
              }
            } catch (err) {
              log(`Error checking server file: ${err}`);
            }
            return false;
          };
 
         // Poll for the server file
         const poll = setInterval(async () => {
            log(`Polling attempt...`);
           if (await checkServerFile()) {
             clearInterval(poll);
           }
         }, 2000);

         // Timeout for polling
         setTimeout(() => {
           clearInterval(poll);
           reject(new Error('Timed out waiting for Jupyter server file.'));
         }, 120000); // 2 minutes timeout

          jupyterProcess.on('error', (err) => {
            log(`Jupyter process error: ${err.message}`);
            jupyterServerProcess = null;
            reject({
              status: 'error',
              message: 'Failed to start Jupyter process.',
              error: err.message,
            });
          });

          jupyterProcess.on('close', (code) => {
            log(`Jupyter process closed with code: ${code}`);
            jupyterServerProcess = null;
            if (code !== 0) {
              reject({
                status: 'error',
                message: `Jupyter process exited with code ${code}.`,
                stderr: stderr,
              });
            }
          });
        } catch (e: any) {
          log(`Critical error in handler: ${e.message}`);
          reject({ status: 'error', message: e.message });
        }
      });
    },
  },
  {
    name: 'stop_jupyter_server',
    description: "Arrête le serveur Jupyter géré par le MCP.",
    schema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      const logPath = 'D:/dev/CoursIA/jupyter-mcp-debug.log';
      const log = (message) => require('fs').appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`);
      log('--- stop_jupyter_server handler called ---');
      
      await cleanupOrphanedJupyterProcesses(log);
      jupyterServerProcess = null; // Clear the in-memory reference
      
      return {
        status: 'success',
        message: 'All Jupyter server processes stopped successfully.',
      };
    }
  },
  {
    name: 'debug_list_runtime_dir',
    description: 'DEBUG: Lists files in the Jupyter runtime directory.',
    schema: { type: 'object', properties: {} },
    handler: async () => {
        const runtimeDir = require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'jupyter', 'runtime');
        const fs = require('fs');
        try {
            const files = fs.readdirSync(runtimeDir);
            return { status: 'success', files: files };
        } catch (error: any) {
            return { status: 'error', message: error.message, stack: error.stack };
        }
    }
  }
];