import { spawn } from 'child_process';
// Définir ToolSchema comme un type
type ToolSchema = {
  type: string;
  properties: Record<string, any>;
  required?: string[];
};


const startJupyterServerSchema: ToolSchema = {
  type: 'object',
  properties: {},
  required: []
};

export const serverTools = [
  {
    name: 'start_jupyter_server',
    description: "Démarre un serveur Jupyter Lab en utilisant la configuration définie dans les paramètres du MCP.",
    schema: startJupyterServerSchema,
    handler: async () => {
      return new Promise((resolve, reject) => {
        const startup_mode = process.env.JUPYTER_STARTUP_MODE || 'conda';
        const envName = process.env.JUPYTER_CONDA_ENV_NAME;
        const condaPath = process.env.JUPYTER_CONDA_PATH || "C:\\ProgramData\\miniconda3\\Scripts\\conda.exe";
        const jupyterPath = process.env.JUPYTER_DIRECT_PATH;

        const jupyterArgs = ['--no-browser', '--ServerApp.token=\'\'', '--ServerApp.password=\'\'', '--ServerApp.disable_check_xsrf=True'];

        let command: string;
        let commandArgs: string[];

        if (startup_mode === 'conda') {
          if (!envName) {
            return reject(new Error("La variable d'environnement 'JUPYTER_CONDA_ENV_NAME' est requise pour le mode de démarrage 'conda'."));
          }
          command = condaPath;
          commandArgs = ['run', '-n', envName, 'jupyter-lab', ...jupyterArgs];
        } else if (startup_mode === 'direct') {
          if (!jupyterPath) {
            return reject(new Error("La variable d'environnement 'JUPYTER_DIRECT_PATH' est requise pour le mode de démarrage 'direct'."));
          }
          command = jupyterPath;
          commandArgs = jupyterArgs;
        } else {
          return reject(new Error(`Mode de démarrage inconnu: ${startup_mode}`));
        }
        
        const jupyterProcess = spawn(command, commandArgs, {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        let stderr = '';
        jupyterProcess.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        jupyterProcess.on('error', (err) => {
          reject({
            status: 'error',
            message: 'Failed to start Jupyter process.',
            error: err.message,
          });
        });

        jupyterProcess.on('close', (code) => {
          if (code !== 0) {
            reject({
              status: 'error',
              message: `Jupyter process exited with code ${code}.`,
              stderr: stderr,
            });
          }
        });
        
        // Give the process a moment to error out on startup
        setTimeout(() => {
          if (jupyterProcess.pid) {
            jupyterProcess.unref();
            resolve({
              pid: jupyterProcess.pid,
              status: 'started',
              command: command,
              arguments: commandArgs,
            });
          } else if (!stderr) {
            // If there's no PID and no stderr, something is wrong.
            reject({
                status: 'error',
                message: 'Process did not start and produced no error output.',
            });
          }
        }, 1000); // 1-second timeout to catch immediate errors
      });
    }
  },
  {
    name: 'stop_jupyter_server',
    description: "Arrête tous les serveurs Jupyter en cours d'exécution.",
    schema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: async () => {
      return new Promise((resolve, reject) => {
        const command = 'powershell';
        const args = ['-c', 'Get-Process jupyter-lab -ErrorAction SilentlyContinue | Stop-Process -Force'];
        
        const stopProcess = spawn(command, args, {
          detached: true,
          stdio: 'ignore',
        });

        stopProcess.on('error', (err) => {
          reject({
            status: 'error',
            message: 'Failed to stop Jupyter process.',
            error: err.message,
          });
        });

        stopProcess.on('close', (code) => {
          if (code !== 0) {
            reject({
              status: 'error',
              message: `Stop process exited with code ${code}.`,
            });
          } else {
            resolve({
              status: 'success',
              message: 'Jupyter server stopped successfully.',
            });
          }
        });
      });
    }
  }
];