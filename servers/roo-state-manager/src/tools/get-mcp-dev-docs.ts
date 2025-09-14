import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface McpServer {
    transportType?: string;
    autoStart?: boolean;
    description?: string;
    disabled?: boolean;
    restart?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    options?: Record<string, any>;
    autoApprove?: string[];
    alwaysAllow?: string[];
}

interface McpSettings {
    mcpServers: Record<string, McpServer>;
}

const MCP_SETTINGS_PATH = path.join(
    process.env.APPDATA || '',
    'Code',
    'User',
    'globalStorage',
    'rooveterinaryinc.roo-cline',
    'settings',
    'mcp_settings.json'
);

async function getMcpConfiguration(): Promise<McpSettings | null> {
    try {
        const content = await fs.readFile(MCP_SETTINGS_PATH, 'utf-8');
        return JSON.parse(content) as McpSettings;
    } catch {
        return null;
    }
}

async function getMcpPath(mcpName: string, config: McpServer): Promise<string | null> {
    try {
        if (config.options?.cwd) {
            return config.options.cwd;
        } else if (config.args?.[0]) {
            return path.dirname(path.dirname(config.args[0]));
        } else if (config.command && config.command.includes('node') && config.args) {
            const firstArg = config.args[0];
            if (firstArg && (firstArg.includes('/') || firstArg.includes('\\'))) {
                return path.dirname(path.dirname(firstArg));
            }
        }
        return null;
    } catch {
        return null;
    }
}

async function scanMcpDirectory(mcpPath: string): Promise<string> {
    try {
        const stats = await fs.stat(mcpPath);
        if (!stats.isDirectory()) {
            return `⚠️ Le chemin ${mcpPath} n'est pas un répertoire valide.\n`;
        }

        let tree = `📁 Structure du MCP (${path.basename(mcpPath)}):\n`;
        tree += `📍 Chemin: ${mcpPath}\n\n`;

        const keyPaths = [
            'package.json', 'README.md', 'src/', 'build/', 'dist/', 'lib/',
            'index.js', 'index.ts', 'server.js', 'server.ts', 'tsconfig.json',
            'test/', 'tests/', '__tests__/', 'docs/', '.env', '.env.example'
        ];

        for (const keyPath of keyPaths) {
            const fullPath = path.join(mcpPath, keyPath);
            try {
                const stat = await fs.stat(fullPath);
                if (stat.isDirectory()) {
                    tree += `📁 ${keyPath}\n`;
                    if (['src', 'build', 'dist', 'lib', 'test', 'tests', '__tests__'].includes(keyPath.replace('/', ''))) {
                        try {
                            const contents = await fs.readdir(fullPath);
                            for (const item of contents.slice(0, 10)) {
                                const itemPath = path.join(fullPath, item);
                                const itemStat = await fs.stat(itemPath);
                                const icon = itemStat.isDirectory() ? '📁' : '📄';
                                tree += `  └─ ${icon} ${item}\n`;
                            }
                            if (contents.length > 10) {
                                tree += `  └─ ... (${contents.length - 10} autres fichiers)\n`;
                            }
                        } catch { }
                    }
                } else {
                    tree += `📄 ${keyPath}\n`;
                }
            } catch { }
        }

        return tree;
    } catch (error) {
        return `⚠️ Erreur lors du scan de ${mcpPath}: ${error instanceof Error ? error.message : String(error)}\n`;
    }
}

async function getPackageInfo(mcpPath: string): Promise<string> {
    try {
        const packageJsonPath = path.join(mcpPath, 'package.json');
        const content = await fs.readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(content);
        
        let info = `📦 Informations du package:\n`;
        info += `• Nom: ${packageJson.name || 'N/A'}\n`;
        info += `• Version: ${packageJson.version || 'N/A'}\n`;
        info += `• Description: ${packageJson.description || 'N/A'}\n`;
        
        if (packageJson.scripts) {
            info += `• Scripts disponibles:\n`;
            Object.keys(packageJson.scripts).forEach(script => {
                info += `  - ${script}: ${packageJson.scripts[script]}\n`;
            });
        }

        if (packageJson.dependencies) {
            info += `• Dépendances principales (${Object.keys(packageJson.dependencies).length}):\n`;
            Object.keys(packageJson.dependencies).slice(0, 10).forEach(dep => {
                info += `  - ${dep}@${packageJson.dependencies[dep]}\n`;
            });
        }

        return info + '\n';
    } catch {
        return `📦 Aucun package.json trouvé dans ${mcpPath}\n\n`;
    }
}

export const getMcpDevDocs = {
    name: 'get_mcp_dev_docs',
    description: '🔧 **OUTIL EXPERT DE DÉVELOPPEMENT MCP** - Guide complet de debugging MCP basé sur l\'expérience SDDD réelle. Fournit workflows systématiques, patterns éprouvés, et arborescence de développement pour agents externes.',
    inputSchema: {
        type: 'object',
        properties: {
            mcp_name: {
                type: 'string',
                description: 'Nom optionnel du MCP spécifique à analyser (ex: "roo-state-manager", "quickfiles", etc.). Si fourni, inclut l\'arborescence de développement et la configuration du MCP.'
            },
        },
        required: [],
    },
    async handler(args?: { mcp_name?: string }): Promise<CallToolResult> {
        try {
            let combinedContent = `# 🔧 GUIDE EXPERT DE DÉBOGAGE MCP - Framework Roo\n\n`;
            combinedContent += `*Basé sur l'expérience SDDD réelle de stabilisation de 3 MCPs critiques*\n\n`;
            
            // === SECTION 1: PATTERNS DE DÉBOGAGE ÉPROUVÉS ===
            combinedContent += `## ⭐ PATTERNS DE DÉBOGAGE ÉPROUVÉS\n\n`;
            
            combinedContent += `### 🎯 1. Pattern "Progressive Isolation"\n`;
            combinedContent += `**Principe:** Réduire progressivement le code jusqu'à isoler le problème exact\n`;
            combinedContent += `**Application:** Version ultra-minimale → ajout progressif → identification du point de blocage\n`;
            combinedContent += `**Exemple vécu:** timeout 60s même avec \`return {}\` immédiat = problème d'infrastructure\n\n`;
            
            combinedContent += `### 🔄 2. Pattern "Force Reload Critical"\n`;
            combinedContent += `**Problème:** Modifications MCP non prises en compte sans rechargement forcé\n`;
            combinedContent += `**Solution:** \`touch_mcp_settings\` obligatoire après chaque modification\n`;
            combinedContent += `**Fréquence:** 100% des cas de modification de code MCP\n\n`;
            
            combinedContent += `### 🛡️ 3. Pattern "Exception Wrapping"\n`;
            combinedContent += `**Technique:** Try/catch avec fallback gracieux et diagnostic détaillé\n`;
            combinedContent += `**Impact:** Évite les crashes complets du MCP\n`;
            combinedContent += `**Exemple concret:** Patch de roo-storage-detector.ts\n\n`;
            
            combinedContent += `### 🩺 4. Pattern "Environment Diagnostic First"\n`;
            combinedContent += `**Approche:** Toujours diagnostiquer l'environnement avant de chercher des bugs de logique\n`;
            combinedContent += `**Outils:** system_info, read_vscode_logs, manage_mcp_settings\n\n`;
            
            // === SECTION 2: WORKFLOW SYSTÉMATIQUE ===
            combinedContent += `## ⚡ WORKFLOW DE DÉBOGAGE SYSTÉMATIQUE\n\n`;
            combinedContent += `\`\`\`bash\n`;
            combinedContent += `# 1. Diagnostic initial\n`;
            combinedContent += `use_mcp_tool roo-state-manager manage_mcp_settings {"action": "read"}\n`;
            combinedContent += `use_mcp_tool [mcp-name] system_info {}\n\n`;
            combinedContent += `# 2. Force reload après modification\n`;
            combinedContent += `use_mcp_tool roo-state-manager touch_mcp_settings {}\n\n`;
            combinedContent += `# 3. Progressive isolation si problème persiste\n`;
            combinedContent += `# Version minimale → ajout progressif → identification blocage\n\n`;
            combinedContent += `# 4. Logs diagnostic\n`;
            combinedContent += `use_mcp_tool roo-state-manager read_vscode_logs {"filter": "mcp|error"}\n`;
            combinedContent += `\`\`\`\n\n`;
            
            // === SECTION 3: CHECKLIST URGENTE ===
            combinedContent += `## 🚨 CHECKLIST DE DÉBOGAGE URGENT\n\n`;
            combinedContent += `**Quand un MCP ne répond plus:**\n\n`;
            combinedContent += `- [ ] **Force reload:** \`touch_mcp_settings\`\n`;
            combinedContent += `- [ ] **Test connectivité:** outil simple (system_info)\n`;
            combinedContent += `- [ ] **Logs diagnostic:** \`read_vscode_logs\`\n`;
            combinedContent += `- [ ] **Progressive isolation** si timeout persiste\n\n`;
            
            // === SECTION 4: ERREURS COMMUNES ===
            combinedContent += `## 🐛 ERREURS COMMUNES DOCUMENTÉES\n\n`;
            combinedContent += `### TypeScript/Node.js:\n`;
            combinedContent += `- **ENOENT errors:** Chemins hardcodés incorrects (ex: get-mcp-dev-docs.ts)\n`;
            combinedContent += `- **Module resolution:** Build non-reflété nécessitant rebuild_and_restart_mcp\n\n`;
            combinedContent += `### Python:\n`;
            combinedContent += `- **Import timeouts:** Imports lourds (papermill) bloquants en contexte MCP\n`;
            combinedContent += `- **Subprocess conda:** Pattern récurrent de timeout 60s\n\n`;
            combinedContent += `### Infrastructure MCP:\n`;
            combinedContent += `- **Cache persistant:** Code modifié invisible sans force reload\n`;
            combinedContent += `- **Timeout -32001:** Signature d'erreur MCP standard\n\n`;
            
            // === SECTION 5: BONNES PRATIQUES ===
            combinedContent += `## 💡 BONNES PRATIQUES VALIDÉES\n\n`;
            combinedContent += `### ✅ Toujours faire:\n`;
            combinedContent += `- Test avec outils de diagnostic d'abord\n`;
            combinedContent += `- \`touch_mcp_settings\` après chaque modification\n`;
            combinedContent += `- Progressive isolation des problèmes complexes\n`;
            combinedContent += `- Exception wrapping avec fallback gracieux\n\n`;
            combinedContent += `### ❌ Éviter absolument:\n`;
            combinedContent += `- Modifier sans force reload après\n`;
            combinedContent += `- Assumer qu'un timeout = bug de logique (souvent infrastructure)\n`;
            combinedContent += `- Déboguer sans version minimale de test\n\n`;
            
            // === SECTION 6: OUTILS ESSENTIELS ===
            combinedContent += `## 🔄 OUTILS ROO-STATE-MANAGER ESSENTIELS\n\n`;
            combinedContent += `| Outil | Usage Principal | Quand l'utiliser |\n`;
            combinedContent += `|-------|----------------|------------------|\n`;
            combinedContent += `| \`touch_mcp_settings\` | Force reload tous MCPs | Après chaque modif code |\n`;
            combinedContent += `| \`rebuild_and_restart_mcp\` | Build TypeScript + restart | MCPs TypeScript modifiés |\n`;
            combinedContent += `| \`read_vscode_logs\` | Diagnostic erreurs système | Debugging avancé |\n`;
            combinedContent += `| \`manage_mcp_settings\` | Vérification configuration | Setup et diagnostic |\n\n`;

            // === SECTION 7: CONFIGURATION MCP ===
            const mcpSettings = await getMcpConfiguration();
            if (mcpSettings) {
                combinedContent += `## 📋 CONFIGURATION MCP ACTUELLE\n\n`;
                combinedContent += `**Fichier:** \`${MCP_SETTINGS_PATH}\`\n\n`;
                combinedContent += `**MCPs configurés (${Object.keys(mcpSettings.mcpServers).length}):**\n\n`;
                
                for (const [name, config] of Object.entries(mcpSettings.mcpServers)) {
                    const status = config.disabled ? '❌ Désactivé' : '✅ Actif';
                    combinedContent += `### ${name} ${status}\n`;
                    combinedContent += `- Description: ${config.description || 'N/A'}\n`;
                    combinedContent += `- Commande: ${config.command || 'N/A'}\n`;
                    if (config.options?.cwd) {
                        combinedContent += `- Répertoire: ${config.options.cwd}\n`;
                    }
                    combinedContent += `\n`;
                }
                combinedContent += `---\n\n`;
            }

            // === SECTION 8: ANALYSE MCP SPÉCIFIQUE ===
            if (args?.mcp_name) {
                combinedContent += `## 🎯 ANALYSE DÉTAILLÉE: ${args.mcp_name.toUpperCase()}\n\n`;
                
                if (mcpSettings?.mcpServers[args.mcp_name]) {
                    const config = mcpSettings.mcpServers[args.mcp_name];
                    combinedContent += `### ⚙️ Configuration\n`;
                    combinedContent += `\`\`\`json\n${JSON.stringify(config, null, 2)}\n\`\`\`\n\n`;

                    const mcpPath = await getMcpPath(args.mcp_name, config);
                    if (mcpPath) {
                        combinedContent += `### 📁 Arborescence de développement\n\n`;
                        combinedContent += await scanMcpDirectory(mcpPath);
                        combinedContent += `\n`;
                        
                        combinedContent += await getPackageInfo(mcpPath);
                        
                        combinedContent += `### 🚀 Commandes de développement\n\n`;
                        combinedContent += `\`\`\`bash\n`;
                        combinedContent += `# Se placer dans le répertoire\n`;
                        combinedContent += `cd "${mcpPath}"\n\n`;
                        combinedContent += `# Workflow standard\n`;
                        combinedContent += `npm install  # Dépendances\n`;
                        combinedContent += `npm run build  # Build\n`;
                        combinedContent += `npm test  # Tests si disponibles\n\n`;
                        combinedContent += `# Workflow Roo debug\n`;
                        combinedContent += `use_mcp_tool roo-state-manager rebuild_and_restart_mcp {"mcp_name": "${args.mcp_name}"}\n`;
                        combinedContent += `use_mcp_tool roo-state-manager touch_mcp_settings {}\n`;
                        combinedContent += `\`\`\`\n\n`;
                    } else {
                        combinedContent += `⚠️ **Impossible de déterminer le chemin pour ce MCP.**\n\n`;
                    }
                } else {
                    combinedContent += `❌ **MCP "${args.mcp_name}" non trouvé.**\n\n`;
                    if (mcpSettings) {
                        combinedContent += `MCPs disponibles: ${Object.keys(mcpSettings.mcpServers).join(', ')}\n\n`;
                    }
                }
            }

            // === SECTION 9: GROUNDING AGENTS EXTERNES ===
            combinedContent += `## 🎯 GROUNDING POUR AGENTS EXTERNES\n\n`;
            combinedContent += `**Procédure complète pour debugger un MCP défectueux:**\n\n`;
            combinedContent += `1. **Identifier le MCP** via \`manage_mcp_settings read\`\n`;
            combinedContent += `2. **Analyser sa structure** via \`get_mcp_dev_docs --mcp_name=<nom>\`\n`;
            combinedContent += `3. **Vérifier les logs** via \`read_vscode_logs\`\n`;
            combinedContent += `4. **Test minimal** avec Progressive Isolation\n`;
            combinedContent += `5. **Force reload** via \`touch_mcp_settings\`\n`;
            combinedContent += `6. **Rebuild si TypeScript** via \`rebuild_and_restart_mcp\`\n`;
            combinedContent += `7. **Valider la correction** avec tests fonctionnels\n\n`;

            combinedContent += `---\n\n`;
            combinedContent += `*Ce guide est directement issu de nos sessions de débogage SDDD réelles et contient les patterns éprouvés qui ont effectivement résolu des problèmes MCP complexes dans le framework Roo.*\n`;

            return { content: [{ type: 'text' as const, text: combinedContent }] };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return { content: [{ type: 'text' as const, text: `Error retrieving MCP dev docs: ${errorMessage}` }] };
        }
    },
};