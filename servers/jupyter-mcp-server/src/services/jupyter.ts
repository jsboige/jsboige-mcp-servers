import { ServerConnection } from '@jupyterlab/services';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Gardons les choses simples pour l'instant. Pas de managers complexes.
let serverSettings: ServerConnection.ISettings = ServerConnection.makeSettings({
  baseUrl: 'http://localhost:8888',
  token: ''
});

const activeKernels = new Map<string, any>();

export interface JupyterServiceOptions {
  baseUrl?: string;
  token?: string;
  skipConnectionCheck?: boolean;
}

export async function initializeJupyterServices(options?: JupyterServiceOptions) {
  if (options) {
    let baseUrl = options.baseUrl || 'http://localhost:8888';
    baseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const token = options.token || '';
    
    serverSettings = ServerConnection.makeSettings({
      baseUrl: baseUrl,
      token: token,
    });
  }
  // Si le contrôle de connexion n'est pas sauté, on effectue un simple test.
  if (!options?.skipConnectionCheck) {
    try {
      const apiUrl = `${serverSettings.baseUrl}/api`;
      const response = await axios.get(apiUrl, {
          headers: { 'Authorization': `token ${serverSettings.token}` }
      });
      if (response.status !== 200) {
          throw new Error('Failed to connect to Jupyter Server');
      }
      console.log('Jupyter services initialized successfully.');
    } catch (error) {
      console.error('Error initializing Jupyter services:', error);
      // On propage l'erreur pour que le processus appelant puisse la gérer.
      throw error;
    }
  } else {
    // Si on saute le contrôle, on l'indique et on continue sans erreur.
    console.log('Jupyter connection check skipped.');
  }
}

export async function listAvailableKernels(): Promise<any[]> {
  try {
    const apiUrl = `${serverSettings.baseUrl}/api/kernelspecs`;
    console.log(`Fetching kernelspecs from: ${apiUrl}`);
    const response = await axios.get(apiUrl, {
        headers: {
            'Authorization': `token ${serverSettings.token}`,
            'Origin': serverSettings.baseUrl
        }
    });
    return Object.values(response.data.kernelspecs);
  } catch (error) {
    console.error('Error fetching available kernels:', error);
    throw error;
  }
}

// Fonctions factices pour le moment pour les autres opérations
export async function startKernel(kernelName: string = 'python3'): Promise<string> {
    const id = uuidv4();
    activeKernels.set(id, {id, name: kernelName});
    return id;
}

export async function stopKernel(kernelId: string): Promise<boolean> {
    activeKernels.delete(kernelId);
    return true;
}

export async function executeCode(kernelId: string, code: string): Promise<any> {
    return { status: 'ok', output: 'Code execution not implemented in this simplified version.'};
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