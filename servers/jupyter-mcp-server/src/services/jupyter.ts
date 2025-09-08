import { ServerConnection } from '@jupyterlab/services';
import { KernelManager, Kernel } from '@jupyterlab/services';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import util from 'util';
import { log } from '../utils/logger.js';

const execAsync = util.promisify(exec);

let serverSettings: ServerConnection.ISettings | null = null;
let kernelManager: KernelManager | null = null;
const activeKernels = new Map<string, Kernel.IKernelConnection>();

export interface JupyterServiceOptions {
  baseUrl?: string;
  token?: string;
  skipConnectionCheck?: boolean;
}

async function findJupyterServer(): Promise<{ baseUrl: string; token: string }> {
  try {
    const { stdout } = await execAsync('jupyter notebook list');
    const lines = stdout.trim().split('\n');
    if (lines.length > 1) {
      const serverLine = lines[1];
      const match = serverLine.match(/^(http:\/\/[^ ]+)\s*::/);
      if (match) {
        const url = new URL(match[1]);
        const token = url.searchParams.get('token');
        const baseUrl = url.origin;
        if (token) {
          log(`[AUTO-DETECT] Found Jupyter server at ${baseUrl} with token.`);
          return { baseUrl, token };
        }
      }
    }
    throw new Error('No running Jupyter server found or token missing.');
  } catch (error) {
    log(`[AUTO-DETECT_ERROR] Failed to find running Jupyter server: ${error}`);
    log('[AUTO-DETECT] Falling back to default settings: http://localhost:8888');
    return { baseUrl: 'http://localhost:8888', token: '' };
  }
}

export async function initializeJupyterServices(options?: JupyterServiceOptions) {
  let baseUrl: string, token: string;

  if (options?.baseUrl) {
    baseUrl = options.baseUrl;
    token = options.token || '';
  } else {
    const detectedServer = await findJupyterServer();
    baseUrl = detectedServer.baseUrl;
    token = detectedServer.token;
  }
  
  baseUrl = baseUrl.replace(/\/+$/, '');
  
  serverSettings = ServerConnection.makeSettings({
    baseUrl: baseUrl,
    token: token,
  });

  kernelManager = new KernelManager({ serverSettings });

  if (!options?.skipConnectionCheck) {
    try {
      const apiUrl = `${serverSettings.baseUrl}api/status`;
      log(`[DEBUG] Attempting to connect to Jupyter API at: ${apiUrl}`);
      const response = await axios.get(apiUrl, {
          headers: { 'Authorization': `token ${serverSettings.token}` }
      });
      if (response.status !== 200) {
          throw new Error(`Failed to connect to Jupyter Server. Status: ${response.status}`);
      }
      log(`Jupyter services initialized successfully. Server version: ${response.data.version}`);
    } catch (error: any) {
      log('[DEBUG] Detailed error during Jupyter services initialization:');
      if (error.response) {
        log(`[DEBUG] Status: ${error.response.status}`);
        log(`[DEBUG] Data: ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        log('[DEBUG] No response received for API status check.');
      } else {
        log(`[DEBUG] Error message: ${error.message}`);
      }
      log(`Error initializing Jupyter services: ${error}`);
      throw error;
    }
  } else {
    log('Jupyter connection check skipped.');
  }
}

export async function listAvailableKernels(): Promise<any[]> {
  if (!serverSettings) {
    throw new Error('Services Jupyter non initialisés. Utilisez d\'abord l\'outil start_jupyter_server pour vous connecter à un serveur Jupyter.');
  }
  
  try {
    const apiUrl = `${serverSettings.baseUrl}api/kernelspecs`;
    log(`Fetching kernelspecs from: ${apiUrl}`);
    const response = await axios.get(apiUrl, {
        headers: {
            'Authorization': `token ${serverSettings.token}`
        }
    });
    return Object.values(response.data.kernelspecs);
  } catch (error: any) {
    log('[DEBUG] Detailed error fetching available kernels:');
    if (error.response) {
        log(`[DEBUG] Status: ${error.response.status}`);
        log(`[DEBUG] Data: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
        log('[DEBUG] No response received for kernel request.');
    } else {
        log(`[DEBUG] Error message: ${error.message}`);
    }
    log(`Error fetching available kernels: ${error}`);
    throw error;
  }
}

export async function startKernel(kernelName: string = 'python3'): Promise<string> {
    if (!kernelManager) {
        throw new Error("Services Jupyter non initialisés. Utilisez d'abord l'outil start_jupyter_server pour vous connecter à un serveur Jupyter.");
    }
    log(`[KERNEL_LIFECYCLE] Attempting to start kernel: ${kernelName}`);
    const kernel = await kernelManager.startNew({ name: kernelName });
    activeKernels.set(kernel.id, kernel);
    log(`[KERNEL_LIFECYCLE] Kernel started with ID: ${kernel.id}`);
    log(`[KERNEL_LIFECYCLE] Active kernels map updated. Size: ${activeKernels.size}`);
    return kernel.id;
}

export async function stopKernel(kernelId: string): Promise<boolean> {
    log(`[KERNEL_LIFECYCLE] Attempting to stop kernel with ID: ${kernelId}`);
    const kernel = activeKernels.get(kernelId);
    if (kernel) {
        log(`[KERNEL_LIFECYCLE] Kernel found. Shutting down.`);
        await kernel.shutdown();
        activeKernels.delete(kernelId);
        log(`[KERNEL_LIFECYCLE] Kernel shut down and removed from map. Remaining: ${activeKernels.size}`);
        return true;
    }
    log(`[KERNEL_LIFECYCLE_WARN] Attempted to stop a kernel with ID ${kernelId}, but it was not found in the active map.`);
    return false;
}

export async function executeCode(kernelId: string, code: string): Promise<any> {
    if (!kernelManager) {
        throw new Error("Services Jupyter non initialisés. Utilisez d'abord l'outil start_jupyter_server pour vous connecter à un serveur Jupyter.");
    }
    
    log(`[EXECUTION] Attempting to execute code on kernel ID: ${kernelId}`);
    log(`[EXECUTION] Current active kernel IDs: [${Array.from(activeKernels.keys()).join(', ')}]`);
    const kernel = activeKernels.get(kernelId);
    if (!kernel) {
        log(`[EXECUTION_ERROR] Kernel with ID ${kernelId} not found in active map.`);
        throw new Error(`Kernel with ID ${kernelId} not found.`);
    }

    log(`[EXECUTION] Kernel found. Sending execute request.`);
    const future = kernel.requestExecute({ code });
    let output = '';
    let outputs: any[] = [];
    let execution_count = 0;

    return new Promise((resolve, reject) => {
        future.onIOPub = (msg) => {
            const msgType = msg.header.msg_type;
            log(`[EXECUTION_IO] Received IOPub message of type: ${msgType}`);
            
            if (msgType === 'stream' && 'text' in msg.content) {
                log(`[EXECUTION_IO] Stream output: ${msg.content.text}`);
                output += msg.content.text;
                outputs.push({
                    output_type: 'stream',
                    name: 'stdout',
                    text: msg.content.text
                });
            } else if (msgType === 'error' && 'ename' in msg.content && 'evalue' in msg.content && 'traceback' in msg.content) {
                const errorContent = msg.content as { ename: string; evalue: string; traceback: unknown };
                log(`[EXECUTION_IO_ERROR] Execution error: ${errorContent.ename}: ${errorContent.evalue}`);
                if (Array.isArray(errorContent.traceback)) {
                    output += `${errorContent.ename}: ${errorContent.evalue}\n${errorContent.traceback.join('\n')}`;
                }
                outputs.push({
                    output_type: 'error',
                    ename: errorContent.ename,
                    evalue: errorContent.evalue,
                    traceback: errorContent.traceback
                });
            } else if (msgType === 'execute_result') {
                const executeResult = msg.content as any;
                outputs.push({
                    output_type: 'execute_result',
                    data: executeResult.data || {},
                    metadata: executeResult.metadata || {},
                    execution_count: executeResult.execution_count || 0
                });
            } else if (msgType === 'status') {
                log(`[EXECUTION_IO] Kernel status is now: ${(msg.content as any).execution_state}`);
            }
        };

        future.done.then((reply) => {
            log('[EXECUTION] Future completed successfully.');
            execution_count = reply.content.execution_count || 0;
            resolve({
                status: reply.content.status,
                output,
                outputs,
                execution_count
            });
        }).catch((err) => {
            log(`[EXECUTION_ERROR] Future failed: ${err}`);
            reject({ status: 'error', output: err.toString() });
        });
    });
}

export function listActiveKernels(): any[] {
    return Array.from(activeKernels.values());
}

export function getKernel(kernelId: string): any {
    if (!activeKernels.has(kernelId)) {
        throw new Error(`Kernel with ID ${kernelId} not found.`);
    }
    return activeKernels.get(kernelId);
}

export async function interruptKernel(kernelId: string): Promise<boolean> {
    log(`Interrupting kernel ${kernelId} (not implemented).`);
    return true;
}

export async function restartKernel(kernelId: string): Promise<boolean> {
    log(`Restarting kernel ${kernelId} (not implemented).`);
    return true;
}