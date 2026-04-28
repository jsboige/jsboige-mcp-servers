/**
 * Exemple d'utilisation de la Phase 3 - Death Spiral Monitoring
 * #1786: Prévention de la pollution du cache par les exploded tasks
 *
 * Cet exemple montre comment détecter les "death spiral tasks" en temps réel
 * et prendre des actions préventives avant qu'elles ne polluent le cache.
 */

import { roosync_indexing } from '../src/tools/indexing/roosync-indexing.tool.js';

// Exemple 1: Monitoring des tâches suspectes
async function monitorSuspectTasks() {
    console.log('🔍 Monitoring des tâches suspectes pour détecter les death spirals...');

    const result = await roosync_indexing({
        action: 'garbage_monitor',
        monitor_task_ids: [
            'task_xxx_001', // Tâche avec beaucoup d'erreurs 502
            'task_yyy_002', // Tâche avec des timeouts répétés
            'task_zzz_003'  // Tâche suspecte nouvellement créée
        ],
        error_threshold_percent: 75, // Seuil abaissé pour la détection précoce
        assistant_output_threshold_percent: 10, // Tolérance un peu plus élevée
        rapid_error_threshold_count: 3, // Déclencher après 3 erreurs rapides
        time_window_minutes: 15 // Fenêtre de temps plus stricte
    });

    if (!result.isError) {
        const data = JSON.parse(result.content[0].text);

        console.log('\n📊 Rapport de monitoring:');
        console.log(`Death spirals détectées: ${data.death_spirals_detected}`);
        console.log(`Tâches à risque: ${data.tasks_at_risk.length}`);
        console.log(`Actions immédiates recommandées: ${data.immediate_actions.length}`);

        if (data.death_spirals_detected > 0) {
            console.log('\n🚨 Death Spirals:');
            data.analysis.forEach((spiral: any) => {
                console.log(`  - Task ${spiral.task_id}:`);
                console.log(`    Risk: ${spiral.risk_level}`);
                console.log(`    Triggers: ${spiral.triggers.join(', ')}`);
                console.log(`    Error ratio: ${(spiral.error_ratio * 100).toFixed(1)}%`);
                console.log(`    Time to death spiral: ${spiral.time_to_death_spiral}`);
            });
        }

        if (data.immediate_actions.length > 0) {
            console.log('\n⚡ Actions immédiates:');
            data.immediate_actions.forEach((action: any) => {
                console.log(`  - Task ${action.task_id}: ${action.action} - ${action.reason}`);
            });
        }
    }
}

// Exemple 2: Monitoring continu avec alertes
async function continuousMonitoring() {
    console.log('🔄 Monitoring continu des tâches actives...');

    // Simuler un monitoring en temps réel
    const intervalMinutes = 5; // Vérifier toutes les 5 minutes
    const maxRisks = 3; // Alerte si plus de 3 tâches à risque

    const checkInterval = setInterval(async () => {
        try {
            const result = await roosync_indexing({
                action: 'garbage_monitor',
                monitor_task_ids: getActiveTaskIds(), // Fonction à implémenter
                error_threshold_percent: 80,
                assistant_output_threshold_percent: 5,
                rapid_error_threshold_count: 5,
                time_window_minutes: 30
            });

            if (!result.isError) {
                const data = JSON.parse(result.content[0].text);

                if (data.death_spirals_detected > 0) {
                    console.log(`🚨 ALERTE: ${data.death_spirals_detected} death spirals détectées!`);
                    // Déclencher une action d'urgence
                    await handleDeathSpiralEmergency(data);
                }

                if (data.tasks_at_risk.length >= maxRisks) {
                    console.log(`⚠️ ATTENTION: ${data.tasks_at_risk.length} tâches à risque!`);
                    // Envoyer une alerte
                    await sendRiskAlert(data);
                }
            }
        } catch (error) {
            console.error('Erreur pendant le monitoring:', error);
        }
    }, intervalMinutes * 60 * 1000);

    // Exécuter pendant 1 heure
    setTimeout(() => {
        clearInterval(checkInterval);
        console.log('Monitoring continu terminé.');
    }, 60 * 60 * 1000);
}

// Exemple 3: Gestion automatisée des death spirals
async function automatedDeathSpiralManagement() {
    console.log('🤖 Gestion automatisée des death spirals...');

    const result = await roosync_indexing({
        action: 'garbage_monitor',
        monitor_task_ids: getAllCriticalTaskIds(), // Toutes les tâches critiques
        error_threshold_percent: 85, // Seuil très strict
        assistant_output_threshold_percent: 3,
        rapid_error_threshold_count: 7,
        time_window_minutes: 20
    });

    if (!result.isError) {
        const data = JSON.parse(result.content[0].text);

        // Classification automatique des actions
        const criticalTasks = data.analysis.filter((s: any) => s.risk_level === 'CRITICAL');
        const highTasks = data.analysis.filter((s: any) => s.risk_level === 'HIGH');

        if (criticalTasks.length > 0) {
            console.log(`🛑 ${criticalTasks.length} tâches CRITICAL - Terminaison immédiate recommandée`);
            await terminateCriticalTasks(criticalTasks);
        }

        if (highTasks.length > 0) {
            console.log(`🔒 ${highTasks.length} tâches HIGH - Isolement recommandé`);
            await isolateHighTasks(highTasks);
        }

        // Créer un rapport pour l'analyse
        await createDeathSpiralReport(data);
    }
}

// Fonctions auxiliaires (à implémenter selon le cas d'usage)
function getActiveTaskIds(): string[] {
    // Récupérer les IDs des tâches actives depuis le cache
    return ['task_001', 'task_002', 'task_003'];
}

function getAllCriticalTaskIds(): string[] {
    // Récupérer toutes les tâches potentiellement critiques
    return ['critical_task_001', 'critical_task_002'];
}

async function handleDeathSpiralEmergency(data: any) {
    // Logique de traitement d'urgence
    console.log('Traitement d\'urgence déclenché...');
    // Ex: terminer les tâches, envoyer des notifications, etc.
}

async function sendRiskAlert(data: any) {
    // Envoyer une alerte aux administrateurs
    console.log('Envoi d\'alerte pour les tâches à risque...');
}

async function terminateCriticalTasks(tasks: any[]) {
    // Terminer les tâches critiques
    console.log('Termination des tâches critiques...');
    // Implémenter la logique de terminaison
}

async function isolateHighTasks(tasks: any[]) {
    // Isoler les tâches à haut risque
    console.log('Isolation des tâches à haut risque...');
    // Implémenter la logique d'isolement
}

async function createDeathSpiralReport(data: any) {
    // Créer un rapport détaillé
    console.log('Création du rapport death spiral...');
    // Sauvegarder les données pour analyse future
}

// Exporter les exemples
export {
    monitorSuspectTasks,
    continuousMonitoring,
    automatedDeathSpiralManagement
};

/**
 * Notes d'utilisation:
 *
 * 1. monitorSuspectTasks: Idéal pour des inspections ponctuelles
 *    - Surveillance ciblée des tâches suspectes
 *    - Paramètres stricts pour une détection précoce
 *
 * 2. continuousMonitoring: Pour la surveillance en production
 *    - Monitoring automatique en continu
 *    - Alertes basées sur des seuils définis
 *    - Arrêt automatique après une durée définie
 *
 * 3. automatedDeathSpiralManagement: Solution complète automatisée
 *    - Gestion proactive des death spirals
 *    - Actions automatiques selon le niveau de risque
 *    - Reporting pour l'analyse post-mortem
 *
 * Paramètres recommandés:
 * - Production: error_threshold=80%, rapid_error_count=5, time_window=30min
 * - Développement: error_threshold=70%, rapid_error_count=3, time_window=15min
 * - Surveillance stricte: error_threshold=90%, rapid_error_count=3, time_window=10min
 */