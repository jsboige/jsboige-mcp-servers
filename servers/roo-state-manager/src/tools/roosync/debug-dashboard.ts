import { RooSyncService } from '../../services/RooSyncService.js';

/**
 * Outil de debug pour tester le dashboard avec une nouvelle instance forcée
 */
export async function debugDashboard(args: any): Promise<any> {
  try {
    console.log('[DEBUG] debugDashboard - FORCAGE NOUVELLE INSTANCE');
    
    // CRITICAL: Forcer la réinitialisation complète du singleton
    RooSyncService.resetInstance();
    
    // Attendre un peu pour s'assurer que l'instance est bien nettoyée
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Créer une nouvelle instance avec cache désactivé
    const service = RooSyncService.getInstance({ enabled: false });
    
    console.log('[DEBUG] debugDashboard - NOUVELLE INSTANCE CRÉÉE');
    
    // Appeler loadDashboard directement
    const dashboard = await service.loadDashboard();
    
    console.log('[DEBUG] debugDashboard - RÉSULTAT BRUT:', JSON.stringify(dashboard, null, 2));
    
    return {
      success: true,
      dashboard,
      debugInfo: {
        timestamp: new Date().toISOString(),
        instanceForced: true,
        cacheDisabled: true
      }
    };
  } catch (error) {
    console.error('[DEBUG] debugDashboard - ERREUR:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      debugInfo: {
        timestamp: new Date().toISOString()
      }
    };
  }
}