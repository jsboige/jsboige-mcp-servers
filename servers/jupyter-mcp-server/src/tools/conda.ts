import { exec } from 'child_process';
import { promisify } from 'util';
import { log } from '../utils/logger.js';

const execAsync = promisify(exec);

type ToolSchema = {
  type: string;
  properties: Record<string, any>;
  required?: string[];
};

/**
 * Interface représentant un environnement Conda
 */
interface CondaEnvironment {
  name: string;
  path: string;
  isActive: boolean;
}

/**
 * Interface pour le résultat de vérification d'environnement
 */
interface EnvironmentCheckResult {
  exists: boolean;
  path?: string;
  missingPackages?: string[];
  installedPackages?: string[];
}

/**
 * Vérifie si Conda est installé et accessible
 */
async function checkCondaAvailable(): Promise<boolean> {
  try {
    await execAsync('conda --version');
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Parse la sortie de 'conda env list' pour extraire les environnements
 */
function parseCondaEnvList(output: string): CondaEnvironment[] {
  const lines = output.split('\n');
  const environments: CondaEnvironment[] = [];
  
  for (const line of lines) {
    // Ignorer les lignes de commentaires et les lignes vides
    if (line.trim().startsWith('#') || line.trim() === '') {
      continue;
    }
    
    // Format: nom              chemin [*]
    // L'astérisque indique l'environnement actif
    const match = line.match(/^(\S+)\s+(\*\s+)?(.+)$/);
    if (match) {
      const name = match[1];
      const isActive = match[2] !== undefined;
      const path = match[3].trim();
      
      environments.push({
        name,
        path,
        isActive
      });
    }
  }
  
  return environments;
}

// Schémas des outils

const listCondaEnvironmentsSchema: ToolSchema = {
  type: 'object',
  properties: {},
  required: []
};

const createCondaEnvironmentSchema: ToolSchema = {
  type: 'object',
  properties: {
    name: {
      type: 'string',
      description: "Nom de l'environnement Conda à créer"
    },
    python_version: {
      type: 'string',
      description: "Version de Python à installer (ex: '3.10', '3.11')",
      default: '3.10'
    },
    packages: {
      type: 'array',
      items: { type: 'string' },
      description: "Liste optionnelle de packages à installer lors de la création"
    },
    force: {
      type: 'boolean',
      description: "Si true, supprime et recrée l'environnement s'il existe déjà",
      default: false
    }
  },
  required: ['name']
};

const installCondaPackagesSchema: ToolSchema = {
  type: 'object',
  properties: {
    env_name: {
      type: 'string',
      description: "Nom de l'environnement Conda dans lequel installer les packages"
    },
    packages: {
      type: 'array',
      items: { type: 'string' },
      description: "Liste des packages à installer"
    },
    channel: {
      type: 'string',
      description: "Canal Conda optionnel (ex: 'conda-forge')"
    }
  },
  required: ['env_name', 'packages']
};

const checkCondaEnvironmentSchema: ToolSchema = {
  type: 'object',
  properties: {
    env_name: {
      type: 'string',
      description: "Nom de l'environnement Conda à vérifier"
    },
    required_packages: {
      type: 'array',
      items: { type: 'string' },
      description: "Liste optionnelle de packages dont on veut vérifier l'installation"
    }
  },
  required: ['env_name']
};

const setupJupyterMcpEnvironmentSchema: ToolSchema = {
  type: 'object',
  properties: {
    force: {
      type: 'boolean',
      description: "Si true, supprime et recrée l'environnement s'il existe déjà",
      default: false
    },
    additional_packages: {
      type: 'array',
      items: { type: 'string' },
      description: "Packages supplémentaires à installer"
    }
  },
  required: []
};

// Configuration hard-codée pour l'environnement MCP Jupyter
const MCP_JUPYTER_ENV_CONFIG = {
  name: "mcp-jupyter-py310",
  python_version: "3.10",
  required_packages: [
    "papermill",
    "jupyter",
    "ipykernel",
    "ipython",
    "nbformat",
    "nbconvert"
  ]
};

// Implémentation des outils

export const condaTools = [
  {
    name: 'list_conda_environments',
    description: "Liste tous les environnements Conda disponibles sur le système",
    schema: listCondaEnvironmentsSchema,
    handler: async () => {
      log('--- list_conda_environments handler called ---');
      
      // Vérifier si Conda est disponible
      const condaAvailable = await checkCondaAvailable();
      if (!condaAvailable) {
        return {
          status: 'error',
          message: 'Conda n\'est pas installé ou n\'est pas accessible dans le PATH'
        };
      }
      
      try {
        const { stdout } = await execAsync('conda env list');
        const environments = parseCondaEnvList(stdout);
        
        log(`Found ${environments.length} Conda environments`);
        
        return {
          status: 'success',
          environments,
          count: environments.length
        };
      } catch (error: any) {
        log(`Error listing Conda environments: ${error.message}`);
        return {
          status: 'error',
          message: `Erreur lors de la liste des environnements Conda: ${error.message}`,
          stderr: error.stderr
        };
      }
    }
  },
  
  {
    name: 'create_conda_environment',
    description: "Crée un nouvel environnement Conda avec la version Python et les packages spécifiés",
    schema: createCondaEnvironmentSchema,
    handler: async ({ name, python_version = '3.10', packages = [], force = false }) => {
      log('--- create_conda_environment handler called ---');
      log(`Creating environment: ${name}, Python version: ${python_version}, Packages: ${packages.join(', ')}`);
      
      // Vérifier si Conda est disponible
      const condaAvailable = await checkCondaAvailable();
      if (!condaAvailable) {
        return {
          status: 'error',
          message: 'Conda n\'est pas installé ou n\'est pas accessible dans le PATH'
        };
      }
      
      try {
        // Vérifier si l'environnement existe déjà
        const { stdout: listOutput } = await execAsync('conda env list');
        const environments = parseCondaEnvList(listOutput);
        const existingEnv = environments.find(env => env.name === name);
        
        if (existingEnv && !force) {
          return {
            status: 'error',
            message: `L'environnement '${name}' existe déjà. Utilisez force=true pour le recréer.`,
            existingPath: existingEnv.path
          };
        }
        
        if (existingEnv && force) {
          log(`Removing existing environment: ${name}`);
          await execAsync(`conda env remove -n ${name} -y`);
        }
        
        // Construire la commande de création
        const packagesArg = packages.length > 0 ? packages.join(' ') : '';
        const command = `conda create -n ${name} python=${python_version} ${packagesArg} -y`;
        
        log(`Executing: ${command}`);
        const { stdout, stderr } = await execAsync(command, { 
          maxBuffer: 10 * 1024 * 1024  // 10MB buffer pour les longues sorties
        });
        
        log('Environment created successfully');
        
        return {
          status: 'success',
          message: `Environnement '${name}' créé avec succès`,
          name,
          python_version,
          packages,
          output: stdout,
          warnings: stderr
        };
      } catch (error: any) {
        log(`Error creating Conda environment: ${error.message}`);
        return {
          status: 'error',
          message: `Erreur lors de la création de l'environnement: ${error.message}`,
          stderr: error.stderr,
          stdout: error.stdout
        };
      }
    }
  },
  
  {
    name: 'install_conda_packages',
    description: "Installe des packages dans un environnement Conda existant",
    schema: installCondaPackagesSchema,
    handler: async ({ env_name, packages, channel }) => {
      log('--- install_conda_packages handler called ---');
      log(`Installing packages in environment: ${env_name}, Packages: ${packages.join(', ')}`);
      
      // Vérifier si Conda est disponible
      const condaAvailable = await checkCondaAvailable();
      if (!condaAvailable) {
        return {
          status: 'error',
          message: 'Conda n\'est pas installé ou n\'est pas accessible dans le PATH'
        };
      }
      
      try {
        // Vérifier si l'environnement existe
        const { stdout: listOutput } = await execAsync('conda env list');
        const environments = parseCondaEnvList(listOutput);
        const targetEnv = environments.find(env => env.name === env_name);
        
        if (!targetEnv) {
          return {
            status: 'error',
            message: `L'environnement '${env_name}' n'existe pas. Créez-le d'abord avec create_conda_environment.`
          };
        }
        
        // Construire la commande d'installation
        const channelArg = channel ? `-c ${channel}` : '';
        const packagesArg = packages.join(' ');
        const command = `conda install -n ${env_name} ${channelArg} ${packagesArg} -y`;
        
        log(`Executing: ${command}`);
        const { stdout, stderr } = await execAsync(command, {
          maxBuffer: 10 * 1024 * 1024  // 10MB buffer
        });
        
        log('Packages installed successfully');
        
        return {
          status: 'success',
          message: `Packages installés avec succès dans l'environnement '${env_name}'`,
          env_name,
          packages,
          channel,
          output: stdout,
          warnings: stderr
        };
      } catch (error: any) {
        log(`Error installing packages: ${error.message}`);
        return {
          status: 'error',
          message: `Erreur lors de l'installation des packages: ${error.message}`,
          stderr: error.stderr,
          stdout: error.stdout
        };
      }
    }
  },
  
  {
    name: 'check_conda_environment',
    description: "Vérifie l'existence d'un environnement Conda et optionnellement la présence de packages spécifiques",
    schema: checkCondaEnvironmentSchema,
    handler: async ({ env_name, required_packages = [] }) => {
      log('--- check_conda_environment handler called ---');
      log(`Checking environment: ${env_name}, Required packages: ${required_packages.join(', ')}`);
      
      // Vérifier si Conda est disponible
      const condaAvailable = await checkCondaAvailable();
      if (!condaAvailable) {
        return {
          status: 'error',
          message: 'Conda n\'est pas installé ou n\'est pas accessible dans le PATH'
        };
      }
      
      try {
        // Vérifier si l'environnement existe
        const { stdout: listOutput } = await execAsync('conda env list');
        const environments = parseCondaEnvList(listOutput);
        const targetEnv = environments.find(env => env.name === env_name);
        
        if (!targetEnv) {
          return {
            status: 'success',
            exists: false,
            message: `L'environnement '${env_name}' n'existe pas`
          };
        }
        
        const result: EnvironmentCheckResult = {
          exists: true,
          path: targetEnv.path
        };
        
        // Si des packages sont spécifiés, vérifier leur présence
        if (required_packages.length > 0) {
          try {
            const { stdout: packagesOutput } = await execAsync(`conda list -n ${env_name}`);
            
            const installedPackages: string[] = [];
            const lines = packagesOutput.split('\n');
            
            for (const line of lines) {
              if (line.trim().startsWith('#') || line.trim() === '') continue;
              const packageName = line.split(/\s+/)[0];
              if (packageName) {
                installedPackages.push(packageName);
              }
            }
            
            const missingPackages = required_packages.filter(
              pkg => !installedPackages.some(installed => installed.toLowerCase() === pkg.toLowerCase())
            );
            
            result.missingPackages = missingPackages;
            result.installedPackages = required_packages.filter(
              pkg => installedPackages.some(installed => installed.toLowerCase() === pkg.toLowerCase())
            );
            
            return {
              status: 'success',
              ...result,
              message: missingPackages.length > 0
                ? `L'environnement existe mais ${missingPackages.length} package(s) manquent`
                : `L'environnement existe et tous les packages requis sont installés`
            };
          } catch (error: any) {
            log(`Error checking packages: ${error.message}`);
            return {
              status: 'error',
              message: `Erreur lors de la vérification des packages: ${error.message}`,
              ...result
            };
          }
        }
        
        return {
          status: 'success',
          ...result,
          message: `L'environnement '${env_name}' existe`
        };
      } catch (error: any) {
        log(`Error checking Conda environment: ${error.message}`);
        return {
          status: 'error',
          message: `Erreur lors de la vérification de l'environnement: ${error.message}`,
          stderr: error.stderr
        };
      }
    }
  },

  {
    name: 'setup_jupyter_mcp_environment',
    description: "Configure automatiquement l'environnement Conda pour le MCP Jupyter avec tous les packages requis. Utilise une configuration intégrée et ne nécessite aucun paramètre.",
    schema: setupJupyterMcpEnvironmentSchema,
    handler: async ({ force = false, additional_packages = [] }) => {
      log('--- setup_jupyter_mcp_environment handler called ---');
      log(`Force: ${force}, Additional packages: ${additional_packages.join(', ')}`);
      
      const envName = MCP_JUPYTER_ENV_CONFIG.name;
      const pythonVersion = MCP_JUPYTER_ENV_CONFIG.python_version;
      const requiredPackages = MCP_JUPYTER_ENV_CONFIG.required_packages;
      
      // Vérifier si Conda est disponible
      const condaAvailable = await checkCondaAvailable();
      if (!condaAvailable) {
        return {
          success: false,
          action: "failed",
          message: 'Conda n\'est pas installé ou n\'est pas accessible dans le PATH',
          packages: {
            installed: [],
            already_present: [],
            failed: requiredPackages
          }
        };
      }
      
      try {
        // 1. Vérifier si l'environnement existe
        const { stdout: listOutput } = await execAsync('conda env list');
        const environments = parseCondaEnvList(listOutput);
        const existingEnv = environments.find(env => env.name === envName);
        
        let action: "created" | "updated" | "verified" = "verified";
        const installedPackages: string[] = [];
        const alreadyPresentPackages: string[] = [];
        const failedPackages: string[] = [];
        
        if (existingEnv && force) {
          // Supprimer et recréer l'environnement
          log(`Suppression de l'environnement existant: ${envName}`);
          await execAsync(`conda env remove -n ${envName} -y`);
          
          log(`Création de l'environnement ${envName} avec Python ${pythonVersion}`);
          const packagesArg = requiredPackages.join(' ');
          const command = `conda create -n ${envName} python=${pythonVersion} ${packagesArg} -y`;
          
          await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
          action = "created";
          installedPackages.push(...requiredPackages);
          
        } else if (existingEnv) {
          // Vérifier et installer les packages manquants
          log(`Vérification des packages dans l'environnement existant: ${envName}`);
          const { stdout: packagesOutput } = await execAsync(`conda list -n ${envName}`);
          
          const currentPackages: string[] = [];
          const lines = packagesOutput.split('\n');
          
          for (const line of lines) {
            if (line.trim().startsWith('#') || line.trim() === '') continue;
            const packageName = line.split(/\s+/)[0];
            if (packageName) {
              currentPackages.push(packageName.toLowerCase());
            }
          }
          
          const missingPackages = requiredPackages.filter(
            pkg => !currentPackages.includes(pkg.toLowerCase())
          );
          
          if (missingPackages.length > 0) {
            log(`Installation de ${missingPackages.length} packages manquants`);
            const packagesArg = missingPackages.join(' ');
            await execAsync(`conda install -n ${envName} ${packagesArg} -y`, {
              maxBuffer: 10 * 1024 * 1024
            });
            action = "updated";
            installedPackages.push(...missingPackages);
          }
          
          alreadyPresentPackages.push(...requiredPackages.filter(
            pkg => currentPackages.includes(pkg.toLowerCase())
          ));
          
        } else {
          // Créer l'environnement de zéro
          log(`Création de l'environnement ${envName} avec Python ${pythonVersion}`);
          const packagesArg = requiredPackages.join(' ');
          const command = `conda create -n ${envName} python=${pythonVersion} ${packagesArg} -y`;
          
          await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
          action = "created";
          installedPackages.push(...requiredPackages);
        }
        
        // 2. Installer les packages additionnels si fournis
        if (additional_packages.length > 0) {
          log(`Installation de ${additional_packages.length} packages supplémentaires`);
          try {
            const packagesArg = additional_packages.join(' ');
            await execAsync(`conda install -n ${envName} ${packagesArg} -y`, {
              maxBuffer: 10 * 1024 * 1024
            });
            installedPackages.push(...additional_packages);
          } catch (error: any) {
            log(`Échec de l'installation de certains packages additionnels: ${error.message}`);
            failedPackages.push(...additional_packages);
          }
        }
        
        // 3. Obtenir le chemin de l'environnement
        const { stdout: envListOutput } = await execAsync('conda env list');
        const updatedEnvironments = parseCondaEnvList(envListOutput);
        const finalEnv = updatedEnvironments.find(env => env.name === envName);
        
        const successMessage = action === "created"
          ? `Environnement '${envName}' créé avec succès avec tous les packages requis`
          : action === "updated"
          ? `Environnement '${envName}' mis à jour avec les packages manquants`
          : `Environnement '${envName}' vérifié et tous les packages sont présents`;
        
        log(successMessage);
        
        return {
          success: true,
          action,
          environment: {
            name: envName,
            path: finalEnv?.path || "inconnu",
            python_version: pythonVersion
          },
          packages: {
            installed: installedPackages,
            already_present: alreadyPresentPackages,
            failed: failedPackages
          },
          message: successMessage
        };
        
      } catch (error: any) {
        log(`Erreur lors du setup de l'environnement: ${error.message}`);
        return {
          success: false,
          action: "failed",
          environment: {
            name: envName,
            path: "erreur",
            python_version: pythonVersion
          },
          packages: {
            installed: [],
            already_present: [],
            failed: requiredPackages
          },
          message: `Erreur lors du setup de l'environnement: ${error.message}`
        };
      }
    }
  }
];