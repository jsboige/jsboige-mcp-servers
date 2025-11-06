import winston from 'winston';
import fs from 'fs';
import path from 'path';

// Créer le logger avec transports conditionnels
const createLoggerWithConditionalDebug = () => {
  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
      winston.format.timestamp({
        format: 'YYYY-MM-DD HH:mm:ss'
      }),
      winston.format.errors({ stack: true }),
      winston.format.splat(),
      winston.format.json()
    ),
    defaultMeta: { service: 'github-projects-mcp' },
    transports: []
  });

  // Ajout conditionnel des transports de fichiers
  // Activé par MCP_DEBUG_LOGGING=true ou en développement
  const debugLoggingEnabled = process.env.MCP_DEBUG_LOGGING === 'true' ||
                              process.env.NODE_ENV === 'development';
  
  if (debugLoggingEnabled) {
    // Utiliser un chemin simple sans caractères spéciaux
    const logsDir = 'logs';
    
    // Créer le répertoire parent si nécessaire et forcer la création
    try {
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }
    } catch (error) {
      console.error('[GP-MCP][LOGGER] Erreur création dossier logs:', error);
      // Continuer sans logging fichier plutôt que d'échouer complètement
    }
 
    try {
      logger.add(new winston.transports.File({
        filename: path.join(logsDir, 'github-projects-mcp-error.log'),
        level: 'error'
      }));
      logger.add(new winston.transports.File({
        filename: path.join(logsDir, 'github-projects-mcp-combined.log')
      }));
      
      logger.debug("File logging activé pour github-projects-mcp");
    } catch (error) {
      console.error('[GP-MCP][LOGGER] Erreur ajout transports fichier:', error);
      // Continuer sans logging fichier
    }
  }

  // Console uniquement en non-production
  if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    }));
  }

  return logger;
};

const logger = createLoggerWithConditionalDebug();

export default logger;