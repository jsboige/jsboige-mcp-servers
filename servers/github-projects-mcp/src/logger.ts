import winston from 'winston';

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({
      format: 'YYYY-MM-DD HH:mm:ss'
    }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'github-projects-mcp' },
  transports: [
    new winston.transports.File({ filename: 'github-projects-mcp-error.log', level: 'error' }),
    new winston.transports.File({ filename: 'github-projects-mcp-combined.log' }),
  ],
});

//
// Si nous ne sommes pas en production, alors logger aussi sur la console
// avec le format simple.
//
if (process.env.NODE_ENV !== 'production') {
  logger.add(new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    )
  }));
}

export default logger;