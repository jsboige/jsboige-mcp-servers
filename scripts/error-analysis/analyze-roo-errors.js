/**
 * Script d'analyse des logs d'erreurs pour le serveur MCP Jupyter
 * Ce script analyse un fichier de log existant et extrait les erreurs et les solutions
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Configuration
const config = {
  defaultLogFile: path.join(__dirname, 'roo-errors.log'),
  outputFile: path.join(__dirname, 'roo-errors-analysis.md'),
  errorPatterns: [
    {
      pattern: /Erreur lors de l'initialisation des services Jupyter/i,
      solution: "Vérifiez que le serveur Jupyter est bien démarré et accessible à l'URL configurée."
    },
    {
      pattern: /ECONNREFUSED/i,
      solution: "Impossible de se connecter au serveur Jupyter. Vérifiez qu'il est bien démarré sur le port 8888."
    },
    {
      pattern: /token.*invalid/i,
      solution: "Le token d'authentification Jupyter est invalide. Vérifiez la configuration dans servers/jupyter-mcp-server/config.json."
    },
    {
      pattern: /Kernel non trouvé/i,
      solution: "Le kernel demandé n'existe pas ou a été arrêté. Vérifiez l'ID du kernel utilisé."
    },
    {
      pattern: /Outil inconnu/i,
      solution: "L'outil MCP demandé n'existe pas. Vérifiez le nom de l'outil dans votre requête."
    },
    {
      pattern: /Error: spawn .* ENOENT/i,
      solution: "La commande jupyter n'est pas trouvée. Vérifiez que Jupyter est installé et dans votre PATH."
    }
  ]
};

// Classe pour l'analyse des logs
class LogAnalyzer {
  constructor(logFile = config.defaultLogFile) {
    this.logFile = logFile;
    this.errors = [];
    this.errorCount = 0;
    this.infoCount = 0;
    this.startTime = null;
    this.endTime = null;
  }

  // Analyser le fichier de log
  async analyze() {
    console.log(`Analyse du fichier de log: ${this.logFile}`);
    
    if (!fs.existsSync(this.logFile)) {
      console.error(`Erreur: Le fichier ${this.logFile} n'existe pas.`);
      return false;
    }
    
    const fileStream = fs.createReadStream(this.logFile);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    let lineCount = 0;
    
    for await (const line of rl) {
      lineCount++;
      
      // Extraire l'horodatage
      const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/);
      if (timestampMatch) {
        const timestamp = new Date(timestampMatch[1]);
        
        if (!this.startTime || timestamp < this.startTime) {
          this.startTime = timestamp;
        }
        
        if (!this.endTime || timestamp > this.endTime) {
          this.endTime = timestamp;
        }
      }
      
      // Compter les infos et les erreurs
      if (line.includes('[INFO]')) {
        this.infoCount++;
      } else if (line.includes('[ERREUR]')) {
        this.errorCount++;
        
        // Extraire le message d'erreur
        const errorMatch = line.match(/\[ERREUR\] \[(.*?)\] (.*)/);
        if (errorMatch) {
          const source = errorMatch[1];
          const message = errorMatch[2];
          
          // Trouver les solutions possibles
          const solutions = this.findSolutions(message);
          
          this.errors.push({
            timestamp: timestampMatch ? timestampMatch[1] : 'Inconnu',
            source,
            message,
            solutions
          });
        }
      }
    }
    
    console.log(`Analyse terminée. ${lineCount} lignes traitées.`);
    console.log(`${this.infoCount} messages d'information, ${this.errorCount} erreurs.`);
    
    return true;
  }
  
  // Trouver les solutions pour une erreur
  findSolutions(errorMessage) {
    const solutions = [];
    
    for (const { pattern, solution } of config.errorPatterns) {
      if (pattern.test(errorMessage)) {
        solutions.push(solution);
      }
    }
    
    return solutions;
  }
  
  // Générer un rapport d'analyse
  generateReport() {
    if (this.errors.length === 0 && !this.startTime) {
      console.error('Aucune donnée à analyser. Exécutez d\'abord la méthode analyze().');
      return false;
    }
    
    let report = `# Rapport d'analyse des erreurs Roo pour MCP Jupyter\n\n`;
    
    // Informations générales
    report += `## Informations générales\n\n`;
    report += `- **Fichier analysé**: \`${this.logFile}\`\n`;
    report += `- **Période**: ${this.startTime ? this.startTime.toISOString() : 'Inconnue'} à ${this.endTime ? this.endTime.toISOString() : 'Inconnue'}\n`;
    report += `- **Nombre de messages d'information**: ${this.infoCount}\n`;
    report += `- **Nombre d'erreurs**: ${this.errorCount}\n\n`;
    
    // Résumé des erreurs
    report += `## Résumé des erreurs\n\n`;
    
    if (this.errors.length === 0) {
      report += `Aucune erreur détectée dans le fichier de log.\n\n`;
    } else {
      // Regrouper les erreurs par type
      const errorTypes = {};
      
      for (const error of this.errors) {
        const key = error.message;
        if (!errorTypes[key]) {
          errorTypes[key] = {
            count: 0,
            sources: new Set(),
            solutions: error.solutions
          };
        }
        
        errorTypes[key].count++;
        errorTypes[key].sources.add(error.source);
      }
      
      // Afficher les types d'erreurs
      report += `| Erreur | Occurrences | Sources | Solutions |\n`;
      report += `| ------ | ----------- | ------- | --------- |\n`;
      
      for (const [message, data] of Object.entries(errorTypes)) {
        const sources = Array.from(data.sources).join(', ');
        const solutions = data.solutions.length > 0 
          ? data.solutions.map(s => `- ${s}`).join('<br>') 
          : 'Aucune solution suggérée';
        
        report += `| ${message} | ${data.count} | ${sources} | ${solutions} |\n`;
      }
      
      report += `\n`;
    }
    
    // Détail des erreurs
    report += `## Détail des erreurs\n\n`;
    
    if (this.errors.length === 0) {
      report += `Aucune erreur détectée dans le fichier de log.\n\n`;
    } else {
      for (let i = 0; i < this.errors.length; i++) {
        const error = this.errors[i];
        
        report += `### Erreur ${i + 1}\n\n`;
        report += `- **Timestamp**: ${error.timestamp}\n`;
        report += `- **Source**: ${error.source}\n`;
        report += `- **Message**: ${error.message}\n`;
        
        if (error.solutions.length > 0) {
          report += `- **Solutions possibles**:\n`;
          for (const solution of error.solutions) {
            report += `  - ${solution}\n`;
          }
        } else {
          report += `- **Solutions possibles**: Aucune solution suggérée\n`;
        }
        
        report += `\n`;
      }
    }
    
    // Recommandations
    report += `## Recommandations\n\n`;
    
    if (this.errors.length === 0) {
      report += `Aucune erreur détectée, tout semble fonctionner correctement.\n\n`;
    } else {
      // Trouver les solutions les plus fréquentes
      const solutionCounts = {};
      
      for (const error of this.errors) {
        for (const solution of error.solutions) {
          if (!solutionCounts[solution]) {
            solutionCounts[solution] = 0;
          }
          
          solutionCounts[solution]++;
        }
      }
      
      // Trier les solutions par fréquence
      const sortedSolutions = Object.entries(solutionCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([solution, count]) => `1. **${solution}** (suggérée ${count} fois)`);
      
      if (sortedSolutions.length > 0) {
        report += `Voici les actions recommandées pour résoudre les problèmes les plus fréquents:\n\n`;
        report += sortedSolutions.join('\n');
        report += `\n\n`;
      } else {
        report += `Des erreurs ont été détectées, mais aucune solution n'a pu être suggérée automatiquement.\n`;
        report += `Veuillez consulter la documentation du serveur MCP Jupyter pour plus d'informations.\n\n`;
      }
    }
    
    // Pied de page
    report += `---\n\n`;
    report += `Rapport généré le ${new Date().toISOString()} par l'outil d'analyse des erreurs Roo pour MCP Jupyter.\n`;
    
    return report;
  }
  
  // Sauvegarder le rapport dans un fichier
  saveReport(outputFile = config.outputFile) {
    const report = this.generateReport();
    
    if (!report) {
      return false;
    }
    
    try {
      fs.writeFileSync(outputFile, report);
      console.log(`Rapport sauvegardé dans: ${outputFile}`);
      return true;
    } catch (error) {
      console.error(`Erreur lors de la sauvegarde du rapport: ${error.message}`);
      return false;
    }
  }
}

// Fonction principale
async function main() {
  console.log('===== Analyse des logs d\'erreurs pour le serveur MCP Jupyter =====');
  
  // Récupérer le chemin du fichier de log depuis les arguments
  const args = process.argv.slice(2);
  const logFile = args[0] || config.defaultLogFile;
  
  // Créer et exécuter l'analyseur
  const analyzer = new LogAnalyzer(logFile);
  const success = await analyzer.analyze();
  
  if (success) {
    analyzer.saveReport();
    console.log(`\nAnalyse terminée. ${analyzer.errorCount} erreurs trouvées.`);
    
    if (analyzer.errorCount > 0) {
      console.log(`Consultez le rapport pour plus de détails: ${config.outputFile}`);
    }
  }
}

// Exécuter la fonction principale
main().catch(err => {
  console.error('Erreur lors de l\'analyse des logs:', err);
  process.exit(1);
});