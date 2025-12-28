/**
 * UTILITAIRES DE TEST POUR QUICKFILES MCP
 *
 * Fournit des utilitaires communs pour les tests unitaires
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');

/**
 * Crée un serveur mock pour les tests
 */
function createMockServer() {
  const server = new Server(
    {
      name: 'quickfiles-server',
      version: '1.0.0',
    },
    {
      read_multiple_files: async (request) => {
        const { paths, show_line_numbers, max_chars_per_file } = request.params;
        
        // Simuler la lecture de fichiers
        const results = [];
        
        for (const fileRequest of paths) {
          const { path, excerpts } = fileRequest;
          
          // Simuler le contenu du fichier
          let content = `Ligne 1: contenu de test pour ${path}\n`;
          content += `Ligne 2: autre ligne de contenu\n`;
          content += `Ligne 3: ligne avec pattern test.*pattern\n`;
          content += `Ligne 4: ligne normale\n`;
          content += `Ligne 5: fin du fichier\n`;
          // Ajouter plus de lignes pour supporter les extraits jusqu'à la ligne 15
          for (let i = 6; i <= 15; i++) {
            content += `Ligne ${i}: contenu supplémentaire pour les tests\n`;
          }
          
          if (excerpts && excerpts.length > 0) {
            const lines = content.split('\n');
            const excerptLines = [];
           
            for (const excerpt of excerpts) {
              const { start, end } = excerpt;
              const excerptLinesContent = lines.slice(start - 1, end);
              
              // Ajouter la numérotation correcte
              const numberedLines = excerptLinesContent.map((line, index) => {
                const lineNumber = start + index;
                return `${lineNumber}|${line}`;
              });
              
              excerptLines.push(...numberedLines);
            }
           
            content = excerptLines.join('\n');
          }
          
          if (show_line_numbers) {
            const lines = content.split('\n');
            content = lines.map((line, index) => `${index + 1}|${line}`).join('\n');
          }
          
          results.push({
            path,
            content: content.substring(0, max_chars_per_file || content.length)
          });
        }
        
        return {
          content: results.map(r => r.content).join('\n---\n'),
          success: true
        };
      },
      
      edit_multiple_files: async (request) => {
        const { files } = request.params;
        const results = [];
        
        for (const fileRequest of files) {
          const { path, diffs } = fileRequest;
          
          // Simuler le contenu actuel du fichier
          let content = `Ligne 1: contenu original pour ${path}\n`;
          content += `Ligne 2: test.*pattern\n`;
          content += `Ligne 3: /[a-z]+/\n`;
          content += `Ligne 4: ligne normale\n`;
          content += `Ligne 5: fin du fichier\n`;
          
          // Appliquer les modifications
          for (const diff of diffs) {
            const { search, replace, start_line } = diff;
           
            if (start_line !== undefined) {
              // Modification ciblée à une ligne spécifique
              const lines = content.split('\n');
              const targetIndex = start_line - 1; // Convertir en index 0-based
              
              if (targetIndex >= 0 && targetIndex < lines.length) {
                // Utiliser une expression régulière échappée pour la recherche
                const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedSearch, 'g');
                lines[targetIndex] = lines[targetIndex].replace(regex, replace);
                content = lines.join('\n');
              }
            } else {
              // Remplacement global avec pattern échappé
              const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(escapedSearch, 'g');
                content = content.replace(regex, replace);
            }
          }
          
          results.push({
            path,
            content
          });
        }
        
        return {
          content: results.map(r => r.content).join('\n---\n'),
          success: true
        };
      }
    }
  );
  
  // Initialiser les fichiers mock
  server.mockFiles = {};
  
  // Ajouter les méthodes mock au serveur
  server.mockReadMultipleFiles = async (args) => {
    // Simuler la lecture de fichiers
    const results = [];
    for (const file of args.paths) {
      const rawFilePath = typeof file === 'string' ? file : file.path;
      let content = server.mockFiles[rawFilePath];
      
      // Si le fichier n'existe pas, créer un contenu par défaut
      if (!content) {
        content = `Ligne 1: contenu de test pour ${rawFilePath}\n`;
        content += `Ligne 2: autre ligne de contenu\n`;
        content += `Ligne 3: ligne avec pattern test.*pattern\n`;
        content += `Ligne 4: ligne normale\n`;
        content += `Ligne 5: fin du fichier\n`;
        // Ajouter plus de lignes pour supporter les extraits jusqu'à la ligne 15
        for (let i = 6; i <= 15; i++) {
          content += `Ligne ${i}: contenu supplémentaire pour les tests\n`;
        }
        server.mockFiles[rawFilePath] = content;
      }
      
      // Gérer les extraits si présents
      if (file.excerpts && file.excerpts.length > 0) {
        const lines = content.split('\n');
        const excerptLines = [];
       
        for (let i = 0; i < file.excerpts.length; i++) {
          const excerpt = file.excerpts[i];
          const { start, end } = excerpt;
          const excerptLinesContent = lines.slice(start - 1, end);
          
          // Ajouter la numérotation correcte pour chaque ligne de l'extrait
          const numberedLines = excerptLinesContent.map((line, index) => {
            const lineNumber = start + index;
            return `${lineNumber}|${line}`;
          });
          
          excerptLines.push(...numberedLines);
          // Ajouter un séparateur entre les extraits multiples (sauf le dernier)
          if (i < file.excerpts.length - 1) {
            excerptLines.push(''); // Ligne vide pour séparer les extraits
          }
        }
       
        content = excerptLines.join('\n');
      }
      
      // Ajouter la numérotation des lignes si demandé
      if (args.show_line_numbers && !file.excerpts) {
        const lines = content.split('\n');
        content = lines.map((line, index) => `${index + 1}|${line}`).join('\n');
      }
      
      results.push({
        path: rawFilePath,
        content: content.substring(0, args.max_chars_per_file || content.length),
        truncated: false
      });
    }
    
    const formattedResponse = results.map(f => f.content).join('\n---\n');
    
    return {
      content: formattedResponse,
      success: true
    };
  };

  server.mockListDirectoryContents = async (args) => {
    return { content: 'Mock directory listing', success: true };
  };

  server.mockDeleteFiles = async (args) => {
    return { content: 'Mock delete operation', success: true };
  };

  server.mockEditMultipleFiles = async (args) => {
    const results = [];
    
    for (const fileRequest of args.files) {
      const { path, diffs } = fileRequest;
      
      // Obtenir ou créer le contenu du fichier
      let content = server.mockFiles[path];
      if (!content) {
        content = `Ligne 1: contenu original pour ${path}\n`;
        content += `Ligne 2: test.*pattern\n`;
        content += `Ligne 3: /[a-z]+/\n`;
        content += `Ligne 4: ligne normale\n`;
        content += `Ligne 5: fin du fichier\n`;
      }
      
      // Appliquer les modifications
      for (const diff of diffs) {
        const { search, replace, start_line } = diff;
       
        if (start_line !== undefined) {
          // Modification ciblée à une ligne spécifique
          const lines = content.split('\n');
          const targetIndex = start_line - 1; // Convertir en index 0-based
          
          if (targetIndex >= 0 && targetIndex < lines.length) {
            // Utiliser une expression régulière échappée pour la recherche
            const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(escapedSearch, 'g');
            lines[targetIndex] = lines[targetIndex].replace(regex, replace);
            content = lines.join('\n');
          }
        } else {
          // Remplacement global avec pattern échappé
          const escapedSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const regex = new RegExp(escapedSearch, 'g');
          content = content.replace(regex, replace);
        }
      }
      
      // Sauvegarder le contenu modifié
      server.mockFiles[path] = content;
      
      results.push({
        path,
        success: true,
        modifications: diffs.length,
        errors: []
      });
    }
    
    // Retourner le contenu modifié pour les tests
    const modifiedContent = results.map(r => {
      // Retourner le contenu final modifié du fichier
      return server.mockFiles[r.path] || r.content || '';
    }).join('\n---\n');
    
    return {
      content: modifiedContent,
      success: true
    };
  };

  server.mockExtractMarkdownStructure = async (args) => {
    return { content: 'Mock markdown extraction', success: true };
  };

  server.mockCopyFiles = async (args) => {
    return { content: 'Mock copy operation', success: true };
  };

  server.mockMoveFiles = async (args) => {
    return { content: 'Mock move operation', success: true };
  };

  server.mockSearchInFiles = async (args) => {
    return { content: 'Mock search operation', success: true };
  };

  server.mockSearchAndReplace = async (args) => {
    return { content: 'Mock search and replace operation', success: true };
  };

  server.mockRestartMcpServers = async (args) => {
    return { content: 'Mock restart operation', success: true };
  };

  return {
    server,
    transport: async (request) => {
      // Simuler le transport MCP avec des réponses mockées basées sur les outils
      const { name, arguments: args } = request.params || request;
      
      // Simuler les réponses pour chaque outil
      switch (name) {
        case 'read_multiple_files':
          return await server.mockReadMultipleFiles(args);
        case 'list_directory_contents':
          return await server.mockListDirectoryContents(args);
        case 'delete_files':
          return await server.mockDeleteFiles(args);
        case 'edit_multiple_files':
          return await server.mockEditMultipleFiles(args);
        case 'extract_markdown_structure':
          return await server.mockExtractMarkdownStructure(args);
        case 'copy_files':
          return await server.mockCopyFiles(args);
        case 'move_files':
          return await server.mockMoveFiles(args);
        case 'search_in_files':
          return await server.mockSearchInFiles(args);
        case 'search_and_replace':
          return await server.mockSearchAndReplace(args);
        case 'restart_mcp_servers':
          return await server.mockRestartMcpServers(args);
        default:
          throw new Error(`Tool ${name} not found`);
      }
    },
    close: () => server.close()
  };
}

module.exports = {
  createMockServer
};