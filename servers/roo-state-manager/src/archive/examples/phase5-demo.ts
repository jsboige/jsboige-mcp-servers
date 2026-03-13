/**
 * Archived: 2026-03-13 - Superseded by (never integrated)
 * Reason: Phase 5 interactive features never materialized. Demo code was never imported or used.
 * Features: 7 demo exports (phase5Configuration, sampleMessages, demonstrateInteractiveTableOfContents, demonstrateParameterTruncation, demonstrateMessageCounters, demonstrateInteractiveScript, generateCompletePhase5Demo)
 * Status: No imports found in codebase - confirmed dead code
 * See: README.md in this directory for details
 */

/**
 * Phase 5 Demo - Démonstration des fonctionnalités interactives
 *
 * Ce fichier démontre l'utilisation des nouvelles fonctionnalités Phase 5 :
 * - Table des matières interactive avec compteurs visuels
 * - Troncature intelligente des paramètres d'outils
 * - Interactions JavaScript avancées
 * - Navigation par ancres avec smooth scroll
 */

import {
    ClassifiedContent,
    EnhancedSummaryOptions,
    TruncationOptions,
    InteractiveToCSOptions
} from '../../types/enhanced-conversation.js';
import { MarkdownFormatterService } from '../../services/MarkdownFormatterService.js';

// ===========================
// CONFIGURATION PHASE 5 COMPLÈTE
// ===========================

const phase5Configuration: EnhancedSummaryOptions = {
    // Configuration de base
    detailLevel: 'Full',
    outputFormat: 'html',
    includeCss: true,
    generateToc: true,

    // Phase 5: Configuration de troncature
    truncationOptions: {
        enableTruncation: true,
        maxParameterLength: 500,
        maxResultLength: 1000,
        preserveStructure: true,
        showPreview: true,
        truncationThreshold: 300,
        previewLines: 3,
        expandButtonText: "📖 Voir le contenu complet",
        collapseButtonText: "📚 Réduire"
    } as TruncationOptions,

    // Phase 5: Configuration de table des matières interactive
    interactiveToCSOptions: {
        enableInteractiveToC: true,
        showMessageCounters: true,
        showProgressBars: true,
        enableHierarchicalStructure: true,
        enableSmoothScroll: true,
        enableActiveHighlighting: true,
        enableSearchFilter: true,
        enableCopyToClipboard: true,
        enableCollapsibleSections: true,
        sectionIcons: true
    } as InteractiveToCSOptions,

    // Phase 5: Feature flags avancés
    enhancementFlags: {
        // Phase 4 existant
        enableAdvancedCSS: true,
        enableResponsiveDesign: true,
        enableSyntaxHighlighting: true,
        enableAnimations: true,

        // Phase 5 nouvelles fonctionnalités
        enableInteractiveToC: true,
        enableParameterTruncation: true,
        enableJavaScriptInteractions: true,
        enableAdvancedNavigation: true,
        enableCopyToClipboard: true,
        enableSearchAndFilter: true
    }
};

// ===========================
// DONNÉES DE TEST PHASE 5
// ===========================

const sampleMessages: ClassifiedContent[] = [
    {
        type: 'User',
        subType: 'UserMessage',
        content: 'Peux-tu créer un script Python pour analyser des données CSV ?',
        index: 0,
        contentSize: 58,
        isRelevant: true,
        confidenceScore: 0.9
    },
    {
        type: 'Assistant',
        subType: 'Completion',
        content: 'Je vais créer un script Python pour analyser des données CSV. Commençons par lire le fichier.',
        index: 1,
        contentSize: 97,
        isRelevant: true,
        confidenceScore: 0.95
    },
    {
        type: 'Assistant',
        subType: 'ToolCall',
        content: 'read_file',
        index: 2,
        toolCallDetails: {
            toolName: 'read_file',
            arguments: {
                path: 'data/sample.csv',
                encoding: 'utf-8',
                max_lines: 1000,
                parse_options: {
                    delimiter: ',',
                    header: true,
                    skip_empty_lines: true,
                    columns: ['name', 'age', 'city', 'salary', 'department', 'start_date'],
                    data_types: {
                        age: 'integer',
                        salary: 'float',
                        start_date: 'date'
                    }
                }
            },
            rawXml: '<read_file><path>data/sample.csv</path><encoding>utf-8</encoding></read_file>',
            parseSuccess: true
        },
        contentSize: 45,
        isRelevant: true,
        confidenceScore: 0.85
    },
    {
        type: 'User',
        subType: 'ToolResult',
        content: `CSV file read successfully. Found 500 rows with the following structure:
name,age,city,salary,department,start_date
John Doe,30,Paris,45000.0,Engineering,2020-01-15
Jane Smith,25,Lyon,38000.0,Marketing,2021-03-20
...
[Additional 497 rows with employee data including names, ages, cities, salaries, departments, and start dates. The dataset contains comprehensive information about company employees across multiple departments including Engineering, Marketing, Sales, HR, and Finance. Salary ranges from 25000 to 85000, ages from 22 to 65, and locations across major French cities.]`,
        index: 3,
        toolResultDetails: {
            success: true,
            outputSize: 2840,
            resultType: 'text',
            truncated: false
        },
        contentSize: 2840,
        isRelevant: true,
        confidenceScore: 0.8
    },
    {
        type: 'Assistant',
        subType: 'Thinking',
        content: 'L\'utilisateur veut analyser des données CSV. Je vais maintenant créer un script Python complet qui inclut la lecture, l\'analyse statistique de base, et la visualisation des données.',
        index: 4,
        contentSize: 178,
        isRelevant: true,
        confidenceScore: 0.7
    },
    {
        type: 'Assistant',
        subType: 'Completion',
        content: `Voici un script Python complet pour analyser vos données CSV :

\`\`\`python
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import seaborn as sns
from datetime import datetime

# Configuration
plt.style.use('seaborn-v0_8')
sns.set_palette("husl")

def analyze_csv_data(file_path):
    \"\"\"
    Analyse complète d'un fichier CSV
    \"\"\"
    # Lecture des données
    df = pd.read_csv(file_path)

    # Statistiques de base
    print("=== INFORMATIONS GÉNÉRALES ===")
    print(f"Nombre de lignes: {len(df)}")
    print(f"Nombre de colonnes: {len(df.columns)}")
    print(f"\\nAperçu des données:")
    print(df.head())

    # Analyse statistique
    print("\\n=== STATISTIQUES DESCRIPTIVES ===")
    print(df.describe())

    # Gestion des valeurs manquantes
    print("\\n=== VALEURS MANQUANTES ===")
    missing_data = df.isnull().sum()
    print(missing_data[missing_data > 0])

    # Visualisations
    create_visualizations(df)

    return df

def create_visualizations(df):
    \"\"\"
    Crée des graphiques d'analyse
    \"\"\"
    fig, axes = plt.subplots(2, 2, figsize=(15, 12))

    # Distribution des âges
    df['age'].hist(bins=20, ax=axes[0,0], alpha=0.7)
    axes[0,0].set_title('Distribution des âges')
    axes[0,0].set_xlabel('Âge')
    axes[0,0].set_ylabel('Fréquence')

    # Salaires par département
    df.boxplot(column='salary', by='department', ax=axes[0,1])
    axes[0,1].set_title('Salaires par département')

    # Évolution des embauches
    df['start_date'] = pd.to_datetime(df['start_date'])
    df['year'] = df['start_date'].dt.year
    df['year'].value_counts().sort_index().plot(kind='bar', ax=axes[1,0])
    axes[1,0].set_title('Embauches par année')

    # Corrélation âge/salaire
    axes[1,1].scatter(df['age'], df['salary'], alpha=0.6)
    axes[1,1].set_xlabel('Âge')
    axes[1,1].set_ylabel('Salaire')
    axes[1,1].set_title('Corrélation Âge/Salaire')

    plt.tight_layout()
    plt.savefig('analysis_results.png', dpi=300, bbox_inches='tight')
    plt.show()

if __name__ == "__main__":
    # Utilisation du script
    df = analyze_csv_data('data/sample.csv')

    # Analyses supplémentaires
    print("\\n=== ANALYSES AVANCÉES ===")

    # Top 10 des salaires
    top_salaries = df.nlargest(10, 'salary')
    print("\\nTop 10 des salaires:")
    print(top_salaries[['name', 'department', 'salary']])

    # Moyenne par département
    dept_avg = df.groupby('department')['salary'].agg(['mean', 'count']).round(2)
    print("\\nMoyennes par département:")
    print(dept_avg)
\`\`\`

Ce script fournit une analyse complète incluant :
- Lecture et validation des données
- Statistiques descriptives
- Détection des valeurs manquantes
- Visualisations automatiques
- Analyses par département
- Export des résultats`,
        index: 5,
        contentSize: 3245,
        isRelevant: true,
        confidenceScore: 0.95
    }
];

// ===========================
// FONCTIONS DE DÉMONSTRATION PHASE 5
// ===========================

/**
 * Démontre la génération de table des matières interactive
 */
function demonstrateInteractiveTableOfContents(): string {
    console.log('🚀 Démonstration: Table des Matières Interactive Phase 5');

    const tableOfContents = MarkdownFormatterService.generateTableOfContents(
        sampleMessages,
        phase5Configuration.interactiveToCSOptions
    );

    console.log('✅ Table des matières générée avec compteurs et barres de progression');
    return tableOfContents;
}

/**
 * Démontre la troncature intelligente des paramètres
 */
function demonstrateParameterTruncation(): string {
    console.log('🚀 Démonstration: Troncature Intelligente Phase 5');

    const longParameters = {
        query: 'SELECT * FROM users WHERE created_at > "2023-01-01" AND status = "active" AND department IN ("Engineering", "Marketing", "Sales") ORDER BY created_at DESC',
        options: {
            limit: 1000,
            include_metadata: true,
            format: 'json',
            columns: ['id', 'name', 'email', 'department', 'salary', 'created_at', 'updated_at'],
            filters: {
                salary_min: 30000,
                salary_max: 100000,
                departments: ['Engineering', 'Marketing', 'Sales', 'HR'],
                locations: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice']
            }
        }
    };

    const truncationResult = MarkdownFormatterService.truncateToolParameters(
        longParameters,
        phase5Configuration.truncationOptions
    );

    if (truncationResult.wasTruncated) {
        console.log('✅ Paramètres tronqués intelligemment');
        const toggleHtml = MarkdownFormatterService.generateTruncationToggle(
            JSON.stringify(longParameters, null, 2),
            truncationResult.content,
            'demo-params'
        );
        return toggleHtml;
    }

    return truncationResult.content;
}

/**
 * Démontre les compteurs visuels
 */
function demonstrateMessageCounters(): any {
    console.log('🚀 Démonstration: Compteurs Visuels Phase 5');

    const counters = MarkdownFormatterService.generateMessageCounters(sampleMessages);

    console.log('✅ Compteurs générés:', counters);
    console.log(`- Messages utilisateur: ${counters.User}`);
    console.log(`- Messages assistant: ${counters.Assistant}`);
    console.log(`- Appels d'outils: ${counters.ToolCall}`);
    console.log(`- Résultats d'outils: ${counters.ToolResult}`);
    console.log(`- Total: ${counters.total}`);

    return counters;
}

/**
 * Démontre la génération du script JavaScript interactif
 */
function demonstrateInteractiveScript(): string {
    console.log('🚀 Démonstration: JavaScript Interactif Phase 5');

    const interactiveScript = MarkdownFormatterService.generateInteractiveScript();

    console.log('✅ Script JavaScript généré avec:');
    console.log('  - Smooth scroll vers les sections');
    console.log('  - Toggle pour contenu tronqué');
    console.log('  - Copy to clipboard');
    console.log('  - Recherche dans la table des matières');
    console.log('  - Highlighting actif des liens de navigation');

    return interactiveScript;
}

/**
 * Génère un exemple HTML complet avec toutes les fonctionnalités Phase 5
 */
function generateCompletePhase5Demo(): string {
    console.log('🚀 Génération: Démo HTML Complète Phase 5');

    // CSS avancé avec styles Phase 5
    // Le CSS est directement intégré dans generateAdvancedCSS
    const cssContent = '<style>' +
        'body { font-family: -apple-system, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; }' +
        '.conversation-section { margin: 20px 0; padding: 16px; border-radius: 8px; }' +
        '.user-message { background: #dbeafe; border-left: 4px solid #2563eb; }' +
        '.assistant-message { background: #dcfce7; border-left: 4px solid #059669; }' +
        '.tool-call { background: #fed7aa; border-left: 4px solid #ea580c; }' +
        '.tool-result { background: #e9d5ff; border-left: 4px solid #7c3aed; }' +
        '</style>';

    // Table des matières interactive
    const tableOfContents = demonstrateInteractiveTableOfContents();

    // Contenu des messages avec ancres
    let bodyContent = '';
    sampleMessages.forEach((message, index) => {
        const anchor = MarkdownFormatterService.generateNavigationAnchors(index, message.subType);

        let messageHtml = '';

        switch (message.subType) {
            case 'UserMessage':
                messageHtml = MarkdownFormatterService.formatUserMessage(message.content);
                break;
            case 'Completion':
                messageHtml = MarkdownFormatterService.formatAssistantMessage(message.content);
                break;
            case 'ToolCall':
                if (message.toolCallDetails) {
                    messageHtml = MarkdownFormatterService.formatToolCall(
                        message.toolCallDetails.toolName,
                        message.toolCallDetails.arguments
                    );
                }
                break;
            case 'ToolResult':
                messageHtml = MarkdownFormatterService.formatToolResult('read_file', message.content);
                break;
            default:
                messageHtml = `<div class="conversation-section">${message.content}</div>`;
        }

        bodyContent += `<div id="${anchor}">\n${messageHtml}\n</div>\n`;
    });

    // Script interactif
    const interactiveScript = demonstrateInteractiveScript();

    // HTML final
    const finalHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roo Phase 5 - Démonstration Interactive</title>
    ${cssContent}
</head>
<body>
    <header>
        <h1>🚀 Roo Phase 5 - Démonstration Interactive</h1>
        <p>Cette page démontre toutes les nouvelles fonctionnalités Phase 5 :</p>
        <ul>
            <li>✨ Table des matières interactive avec compteurs visuels</li>
            <li>📚 Troncature intelligente des paramètres</li>
            <li>⚡ Interactions JavaScript avancées</li>
            <li>🎯 Navigation par ancres avec smooth scroll</li>
            <li>🔍 Recherche et filtrage dynamique</li>
            <li>📋 Copy-to-clipboard automatique</li>
        </ul>
    </header>

    ${tableOfContents}

    <main>
        <h2>💬 Conversation Exemple</h2>
        ${bodyContent}
    </main>

    <footer>
        <p>Generated by Roo State Manager - Phase 5 Interactive Features</p>
    </footer>

    ${interactiveScript}
</body>
</html>`;

    console.log('✅ HTML complet généré avec toutes les fonctionnalités Phase 5');
    return finalHtml;
}

// ===========================
// EXPORT DES FONCTIONS DEMO
// ===========================

export {
    phase5Configuration,
    sampleMessages,
    demonstrateInteractiveTableOfContents,
    demonstrateParameterTruncation,
    demonstrateMessageCounters,
    demonstrateInteractiveScript,
    generateCompletePhase5Demo
};

// ===========================
// UTILISATION EXEMPLE
// ===========================

/*
// Pour utiliser cette démo :

import {
    generateCompletePhase5Demo,
    demonstrateMessageCounters
} from './phase5-demo.js';

// Générer une démo complète
const htmlDemo = generateCompletePhase5Demo();
console.log(htmlDemo);

// Tester les compteurs
const counters = demonstrateMessageCounters();
console.log('Compteurs:', counters);
*/
