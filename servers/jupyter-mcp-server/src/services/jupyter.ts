import { ServerConnection } from '@jupyterlab/services';
import { KernelManager, Kernel } from '@jupyterlab/services';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { exec } from 'child_process';
import util from 'util';

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
          console.log(`[AUTO-DETECT] Found Jupyter server at ${baseUrl} with token.`);
          return { baseUrl, token };
        }
      }
    }
    throw new Error('No running Jupyter server found or token missing.');
  } catch (error) {
    console.error('[AUTO-DETECT] Failed to find running Jupyter server:', error);
    console.log('[AUTO-DETECT] Falling back to default settings: http://localhost:8888');
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
  
  baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  
  serverSettings = ServerConnection.makeSettings({
    baseUrl: baseUrl,
    token: token,
  });

  kernelManager = new KernelManager({ serverSettings });

  if (!options?.skipConnectionCheck) {
    try {
      const apiUrl = `${serverSettings.baseUrl}api/status`;
      console.log(`[DEBUG] Attempting to connect to Jupyter API at: ${apiUrl}`);
      const response = await axios.get(apiUrl, {
          headers: { 'Authorization': `token ${serverSettings.token}` }
      });
      if (response.status !== 200) {
          throw new Error(`Failed to connect to Jupyter Server. Status: ${response.status}`);
      }
      console.log('Jupyter services initialized successfully. Server version:', response.data.version);
    } catch (error: any) {
      console.error('[DEBUG] Detailed error during Jupyter services initialization:');
      if (error.response) {
        console.error(`[DEBUG] Status: ${error.response.status}`);
        console.error('[DEBUG] Data:', error.response.data);
      } else if (error.request) {
        console.error('[DEBUG] No response received:', error.request);
      } else {
        console.error('[DEBUG] Error message:', error.message);
      }
      console.error('Error initializing Jupyter services:', error);
      throw error;
    }
  } else {
    console.log('Jupyter connection check skipped.');
  }
}

export async function listAvailableKernels(): Promise<any[]> {
  try {
    const apiUrl = `${serverSettings.baseUrl}api/kernelspecs`;
    console.log(`Fetching kernelspecs from: ${apiUrl}`);
    const response = await axios.get(apiUrl, {
        headers: {
            'Authorization': `token ${serverSettings.token}`
        }
    });
    return Object.values(response.data.kernelspecs);
  } catch (error: any) {
    console.error('[DEBUG] Detailed error fetching available kernels:');
    if (error.response) {
        console.error(`[DEBUG] Status: ${error.response.status}`);
        console.error('[DEBUG] Data:', error.response.data);
    } else if (error.request) {
        console.error('[DEBUG] No response received for kernel request.');
    } else {
        console.error('[DEBUG] Error message:', error.message);
    }
    console.error('Error fetching available kernels:', error);
    throw error;
  }
}

export async function startKernel(kernelName: string = 'python3'): Promise<string> {
    if (!kernelManager) {
        throw new Error("KernelManager not initialized.");
    }
    console.log(`Starting kernel: ${kernelName}`);
    const kernel = await kernelManager.startNew({ name: kernelName });
    activeKernels.set(kernel.id, kernel);
    console.log(`Kernel started with ID: ${kernel.id}`);
    return kernel.id;
}

export async function stopKernel(kernelId: string): Promise<boolean> {
    const kernel = activeKernels.get(kernelId);
    if (kernel) {
        console.log(`Stopping kernel: ${kernelId}`);
        await kernel.shutdown();
        activeKernels.delete(kernelId);
        return true;
    }
    return false;
}

export async function executeCode(kernelId: string, code: string): Promise<any> {
    const kernel = activeKernels.get(kernelId);
    if (!kernel) {
        throw new Error(`Kernel with ID ${kernelId} not found.`);
    }

    const future = kernel.requestExecute({ code });
    let output = '';

    return new Promise((resolve, reject) => {
        future.onIOPub = (msg) => {
            const msgType = msg.header.msg_type;
            if (msgType === 'stream' && 'text' in msg.content) {
                output += msg.content.text;
            } else if (msgType === 'error' && 'ename' in msg.content && 'evalue' in msg.content && 'traceback' in msg.content) {
                const errorContent = msg.content as { ename: string; evalue: string; traceback: unknown };
                if (Array.isArray(errorContent.traceback)) {
                    output += `${errorContent.ename}: ${errorContent.evalue}\n${errorContent.traceback.join('\n')}`;
                }
            }
        };

        future.done.then((reply) => {
            resolve({ status: 'ok', output });
        }).catch((err) => {
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
    console.log(`Interrupting kernel ${kernelId} (not implemented).`);
    return true;
}

export async function restartKernel(kernelId: string): Promise<boolean> {
    console.log(`Restarting kernel ${kernelId} (not implemented).`);
    return true;
}