import { KernelManager, ServerConnection, SessionManager } from '@jupyterlab/services';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// Configuration par défaut pour la connexion au serveur Jupyter
let serverSettings: ServerConnection.ISettings = ServerConnection.makeSettings({
  baseUrl: 'http://localhost:8888',
  wsUrl: 'ws://localhost:8888',
  token: ''
});

// Gestionnaires pour les kernels et les sessions
let kernelManager: KernelManager;
let sessionManager: SessionManager;

// Map pour stocker les kernels actifs
const activeKernels = new Map<string, any>();

/**
 * Initialise les services Jupyter avec les paramètres fournis
 * @param options Options de configuration pour la connexion au serveur Jupyter
 */
export async function initializeJupyterServices(options?: {
  baseUrl?: string;
  token?: string;
}) {
  try {
    // Mettre à jour les paramètres si fournis
    if (options) {
      serverSettings = ServerConnection.makeSettings({
        baseUrl: options.baseUrl || 'http://localhost:8888',
        wsUrl: options.baseUrl?.replace('http', 'ws') || 'ws://localhost:8888',
        token: options.token || ''
      });
    }

    // Initialiser les gestionnaires
    kernelManager = new KernelManager({ serverSettings });
    sessionManager = new SessionManager({ kernelManager, serverSettings });

    // Vérifier la connexion au serveur Jupyter
    await testConnection();

    console.log('Services Jupyter initialisés avec succès');
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'initialisation des services Jupyter:', error);
    throw error;
  }
}

/**
 * Teste la connexion au serveur Jupyter
 */
async function testConnection() {
  try {
    const response = await axios.get(`${serverSettings.baseUrl}/api/kernels`, {
      headers: {
        Authorization: `token ${serverSettings.token}`
      }
    });
    
    if (response.status !== 200) {
      throw new Error(`Erreur de connexion au serveur Jupyter: ${response.status}`);
    }
    
    return true;
  } catch (error) {
    console.error('Erreur lors du test de connexion au serveur Jupyter:', error);
    throw error;
  }
}

/**
 * Démarre un nouveau kernel Jupyter
 * @param kernelName Nom du kernel à démarrer (ex: 'python3')
 * @returns ID du kernel démarré
 */
export async function startKernel(kernelName: string = 'python3'): Promise<string> {
  try {
    const kernel = await kernelManager.startNew({ name: kernelName });
    const kernelId = uuidv4();
    
    activeKernels.set(kernelId, kernel);
    console.log(`Kernel démarré: ${kernelId} (${kernelName})`);
    
    return kernelId;
  } catch (error) {
    console.error('Erreur lors du démarrage du kernel:', error);
    throw error;
  }
}

/**
 * Arrête un kernel actif
 * @param kernelId ID du kernel à arrêter
 */
export async function stopKernel(kernelId: string): Promise<boolean> {
  try {
    const kernel = activeKernels.get(kernelId);
    
    if (!kernel) {
      throw new Error(`Kernel non trouvé: ${kernelId}`);
    }
    
    await kernel.shutdown();
    activeKernels.delete(kernelId);
    console.log(`Kernel arrêté: ${kernelId}`);
    
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'arrêt du kernel:', error);
    throw error;
  }
}

/**
 * Exécute du code sur un kernel spécifique
 * @param kernelId ID du kernel sur lequel exécuter le code
 * @param code Code à exécuter
 * @returns Résultat de l'exécution
 */
export async function executeCode(kernelId: string, code: string): Promise<any> {
  try {
    const kernel = activeKernels.get(kernelId);
    
    if (!kernel) {
      throw new Error(`Kernel non trouvé: ${kernelId}`);
    }
    
    const future = kernel.requestExecute({ code });
    
    return new Promise((resolve, reject) => {
      const outputs: any[] = [];
      
      future.onIOPub = (msg: any) => {
        if (msg.content && msg.header) {
          if (msg.header.msg_type === 'error') {
            outputs.push({
              type: 'error',
              name: msg.content.ename,
              value: msg.content.evalue,
              traceback: msg.content.traceback
            });
          } else if (msg.header.msg_type === 'stream') {
            outputs.push({
              type: 'stream',
              name: msg.content.name,
              text: msg.content.text
            });
          } else if (msg.header.msg_type === 'execute_result' || 
                    msg.header.msg_type === 'display_data') {
            outputs.push({
              type: msg.header.msg_type,
              data: msg.content.data,
              metadata: msg.content.metadata
            });
          }
        }
      };
      
      future.onReply = (msg: any) => {
        resolve({
          status: msg.content.status,
          execution_count: msg.content.execution_count,
          outputs
        });
      };
      
      future.onStderr = (msg: string) => {
        outputs.push({
          type: 'stderr',
          text: msg
        });
      };
      
      future.done.catch(reject);
    });
  } catch (error) {
    console.error('Erreur lors de l\'exécution du code:', error);
    throw error;
  }
}

/**
 * Liste les kernels disponibles sur le serveur Jupyter
 * @returns Liste des spécifications de kernels disponibles
 */
export async function listAvailableKernels(): Promise<any[]> {
  try {
    const specs = await kernelManager.refreshSpecs();
    return Object.values(specs.kernelspecs);
  } catch (error) {
    console.error('Erreur lors de la récupération des kernels disponibles:', error);
    throw error;
  }
}

/**
 * Liste les kernels actifs
 * @returns Liste des kernels actifs
 */
export function listActiveKernels(): { id: string, name: string }[] {
  const kernels: { id: string, name: string }[] = [];
  
  activeKernels.forEach((kernel, id) => {
    kernels.push({
      id,
      name: kernel.name
    });
  });
  
  return kernels;
}

/**
 * Récupère un kernel actif par son ID
 * @param kernelId ID du kernel à récupérer
 * @returns Instance du kernel
 */
export function getKernel(kernelId: string): any {
  const kernel = activeKernels.get(kernelId);
  
  if (!kernel) {
    throw new Error(`Kernel non trouvé: ${kernelId}`);
  }
  
  return kernel;
}

/**
 * Interrompt l'exécution d'un kernel
 * @param kernelId ID du kernel à interrompre
 */
export async function interruptKernel(kernelId: string): Promise<boolean> {
  try {
    const kernel = activeKernels.get(kernelId);
    
    if (!kernel) {
      throw new Error(`Kernel non trouvé: ${kernelId}`);
    }
    
    await kernel.interrupt();
    console.log(`Kernel interrompu: ${kernelId}`);
    
    return true;
  } catch (error) {
    console.error('Erreur lors de l\'interruption du kernel:', error);
    throw error;
  }
}

/**
 * Redémarre un kernel
 * @param kernelId ID du kernel à redémarrer
 */
export async function restartKernel(kernelId: string): Promise<boolean> {
  try {
    const kernel = activeKernels.get(kernelId);
    
    if (!kernel) {
      throw new Error(`Kernel non trouvé: ${kernelId}`);
    }
    
    await kernel.restart();
    console.log(`Kernel redémarré: ${kernelId}`);
    
    return true;
  } catch (error) {
    console.error('Erreur lors du redémarrage du kernel:', error);
    throw error;
  }
}