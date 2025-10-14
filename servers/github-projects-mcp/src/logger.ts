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
    // Optionnel : créer un dossier logs pour éviter d'encombrer la racine
    const logsDir = './logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    logger.add(new winston.transports.File({
      filename: path.join(logsDir, 'github-projects-mcp-error.log'),
      level: 'error'
    }));
    logger.add(new winston.transports.File({
      filename: path.join(logsDir, 'github-projects-mcp-combined.log')
    }));
    
    logger.debug("File logging activé pour github-projects-mcp");
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