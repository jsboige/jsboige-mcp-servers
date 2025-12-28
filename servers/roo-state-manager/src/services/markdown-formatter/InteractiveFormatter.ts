/**
 * InteractiveFormatter - Formatage interactif pour Markdown
 * 
 * Responsable de la génération des composants interactifs (ToC, scripts, etc.)
 * pour les exports Markdown/HTML.
 */

import {
    ClassifiedContent,
    InteractiveToCSOptions,
    MessageCounters
} from '../../types/enhanced-conversation.js';
import { CSSGenerator } from './CSSGenerator.js';

export class InteractiveFormatter {
    /**
     * Génère une table des matières interactive avec compteurs visuels
     */
    static generateTableOfContents(messages: ClassifiedContent[], options?: InteractiveToCSOptions): string {
        const counters = this.generateMessageCounters(messages);
        const showProgressBars = options?.showProgressBars ?? true;
        const enableSearch = options?.enableSearchFilter ?? false;

        let tocContent = `
<div class="toc-container" id="table-of-contents">
    <h2 class="toc-title">📋 Table des Matières</h2>
    
    ${enableSearch ? `
    <div class="toc-search">
        <input type="text" id="toc-search-input" placeholder="Rechercher dans la conversation..." />
    </div>
    ` : ''}
    
    <div class="toc-summary">
        <div class="toc-stats-grid">`;

        // Compteurs visuels
        Object.entries(counters).forEach(([type, count]) => {
            const icon = this.getTypeIcon(type);
            const color = CSSGenerator.getTypeColor(type);
            const percentage = (count / messages.length) * 100;
            
            tocContent += `
            <div class="toc-stat-card" style="border-left: 4px solid ${color}">
                <div class="toc-stat-header">
                    <span class="toc-icon">${icon}</span>
                    <span class="toc-label">${this.getTypeLabel(type)}</span>
                </div>
                <div class="toc-count">${count}</div>
                ${showProgressBars ? `
                <div class="toc-progress-bar">
                    <div class="toc-progress-fill" style="width: ${percentage}%; background: ${color}"></div>
                </div>
                ` : ''}
            </div>`;
        });

        tocContent += `
        </div>
    </div>
    
    <div class="toc-navigation">
        <h3 class="toc-nav-title">Navigation</h3>
        <div class="toc-links">`;

        // Génération des liens de navigation
        messages.forEach((message, index) => {
            const anchor = this.generateNavigationAnchors(index, message.type);
            const icon = this.getTypeIcon(message.type);
            const color = CSSGenerator.getTypeColor(message.type);
            const timestamp = ''; // Timestamp will be handled by the calling code if needed
            
            tocContent += `
            <div class="toc-link-item">
                <a href="#${anchor}" class="toc-link" data-type="${message.type}" style="color: ${color}">
                    <span class="toc-link-icon">${icon}</span>
                    <span class="toc-link-text">#${index + 1} ${this.getTypeLabel(message.type)}</span>
                    ${timestamp ? `<span class="toc-timestamp">${timestamp}</span>` : ''}
                </a>
            </div>`;
        });

        tocContent += `
        </div>
    </div>
</div>`;

        return tocContent;
    }

    /**
     * Génère les ancres de navigation pour un message
     */
    static generateNavigationAnchors(messageIndex: number, messageType: string): string {
        return `message-${messageIndex}-${messageType.toLowerCase()}`;
    }

    /**
     * Calcule les compteurs de messages par type
     */
    static generateMessageCounters(messages: ClassifiedContent[]): MessageCounters {
        const counters: MessageCounters = {
            User: 0,
            Assistant: 0,
            UserMessage: 0,
            ToolResult: 0,
            ToolCall: 0,
            Completion: 0,
            Thinking: 0,
            total: messages.length
        };

        messages.forEach(message => {
            // Compteur par type principal
            switch (message.type) {
                case 'User':
                    counters.User++;
                    break;
                case 'Assistant':
                    counters.Assistant++;
                    break;
            }
            
            // Compteur par sous-type
            switch (message.subType) {
                case 'UserMessage':
                    counters.UserMessage++;
                    break;
                case 'ToolResult':
                    counters.ToolResult++;
                    break;
                case 'ToolCall':
                    counters.ToolCall++;
                    break;
                case 'Completion':
                    counters.Completion++;
                    break;
                case 'Thinking':
                    counters.Thinking++;
                    break;
            }
        });

        return counters;
    }

    /**
     * Génère le script JavaScript interactif Phase 5
     */
    static generateInteractiveScript(): string {
        return `
<script>
// ===========================
// PHASE 5: JAVASCRIPT INTERACTIF
// ===========================

// Smooth scroll vers les sections
function smoothScrollToSection(targetId) {
    const element = document.getElementById(targetId);
    if (element) {
        element.scrollIntoView({
            behavior: 'smooth',
            block: 'start'
        });
        
        // Highlight temporaire
        element.classList.add('highlight-flash');
        setTimeout(() => element.classList.remove('highlight-flash'), 2000);
    }
}

// Toggle pour contenu tronqué
function toggleTruncation(elementId) {
    const truncated = document.getElementById('truncated-' + elementId);
    const full = document.getElementById('full-' + elementId);
    
    if (truncated && full) {
        truncated.classList.toggle('hidden');
        full.classList.toggle('hidden');
    }
}

// Toggle pour contenu expandable
function toggleExpandable(elementId) {
    const content = document.getElementById('expandable-' + elementId);
    const button = content?.previousElementSibling;
    const icon = button?.querySelector('.expand-icon');
    const text = button?.querySelector('.expand-text');
    
    if (content) {
        content.classList.toggle('hidden');
        if (icon) {
            icon.textContent = content.classList.contains('hidden') ? '▶' : '▼';
        }
        if (text) {
            text.textContent = content.classList.contains('hidden') ? 'Développer' : 'Réduire';
        }
    }
}

// Copy to clipboard pour les blocs de code
function copyToClipboard(text, buttonId) {
    navigator.clipboard.writeText(text).then(() => {
        const button = document.getElementById(buttonId);
        if (button) {
            const originalText = button.textContent;
            button.textContent = '✅ Copié !';
            button.style.background = '#10b981';
            
            setTimeout(() => {
                button.textContent = originalText;
                button.style.background = '';
            }, 2000);
        }
    });
}

// Recherche dans la table des matières
function filterTableOfContents() {
    const searchInput = document.getElementById('toc-search-input');
    const tocLinks = document.querySelectorAll('.toc-link-item');
    
    if (!searchInput || !tocLinks) return;
    
    const query = searchInput.value.toLowerCase();
    
    tocLinks.forEach(item => {
        const linkText = item.textContent.toLowerCase();
        if (linkText.includes(query)) {
            item.style.display = '';
        } else {
            item.style.display = 'none';
        }
    });
}

// Initialisation au chargement
document.addEventListener('DOMContentLoaded', function() {
    // Setup search filter
    const searchInput = document.getElementById('toc-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', filterTableOfContents);
    }
    
    // Setup smooth scroll pour tous les liens ToC
    document.querySelectorAll('.toc-link').forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            const targetId = this.getAttribute('href').substring(1);
            smoothScrollToSection(targetId);
        });
    });
    
    // Setup copy buttons pour les blocs de code
    document.querySelectorAll('pre code').forEach((block, index) => {
        const copyButton = document.createElement('button');
        copyButton.className = 'copy-button';
        copyButton.id = 'copy-btn-' + index;
        copyButton.innerHTML = '📋 Copier';
        copyButton.onclick = () => copyToClipboard(block.textContent, copyButton.id);
        
        block.parentNode.style.position = 'relative';
        copyButton.style.position = 'absolute';
        copyButton.style.top = '8px';
        copyButton.style.right = '8px';
        
        block.parentNode.appendChild(copyButton);
    });
});

// Utilitaires pour le highlighting actif des liens
function updateActiveNavigation() {
    const sections = document.querySelectorAll('[id^="message-"]');
    const navLinks = document.querySelectorAll('.toc-link');
    
    let currentActiveSection = null;
    const scrollPosition = window.scrollY + window.innerHeight / 3;
    
    sections.forEach(section => {
        const sectionTop = section.offsetTop;
        const sectionBottom = sectionTop + section.offsetHeight;
        
        if (scrollPosition >= sectionTop && scrollPosition < sectionBottom) {
            currentActiveSection = section;
        }
    });
    
    // Mise à jour des liens actifs
    navLinks.forEach(link => {
        link.classList.remove('active');
        if (currentActiveSection) {
            const targetId = currentActiveSection.id;
            if (link.getAttribute('href') === '#' + targetId) {
                link.classList.add('active');
            }
        }
    });
}

// Scroll listener pour la navigation active
let scrollTimeout;
window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(updateActiveNavigation, 100);
});

</script>`;
    }

    /**
     * Retourne l'icône appropriée pour un type de message
     */
    private static getTypeIcon(type: string): string {
        switch (type) {
            case 'user': return '🔵';
            case 'assistant': return '🟢';
            case 'tool_call': return '🟠';
            case 'tool_result': return '🟣';
            case 'metadata': return '⚫';
            case 'error': return '🔴';
            default: return '⚪';
        }
    }

    /**
     * Retourne le label approprié pour un type de message
     */
    private static getTypeLabel(type: string): string {
        switch (type) {
            case 'user': return 'Utilisateur';
            case 'assistant': return 'Assistant';
            case 'tool_call': return 'Appel Outil';
            case 'tool_result': return 'Résultat Outil';
            case 'metadata': return 'Métadonnées';
            case 'error': return 'Erreur';
            default: return 'Inconnu';
        }
    }
}