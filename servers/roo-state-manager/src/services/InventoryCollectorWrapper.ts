/**
 * InventoryCollectorWrapper - Wrapper pour l'InventoryCollector existant
 * 
 * Ce wrapper adapte l'InventoryCollector existant pour qu'il implémente
 * l'interface IInventoryCollector requise par le BaselineService.
 * 
 * @module InventoryCollectorWrapper
 * @version 2.1.0
 */

import { InventoryCollector, MachineInventory } from './InventoryCollector.js';
import { IInventoryCollector, MachineInventory as BaselineMachineInventory } from '../types/baseline.js';

/**
 * Wrapper implémentant IInventoryCollector
 */
export class InventoryCollectorWrapper implements IInventoryCollector {
  
  constructor(private inventoryCollector: InventoryCollector) {
    // Le wrapper utilise l'instance existante d'InventoryCollector
  }

  /**
   * Collecte l'inventaire d'une machine
   */
  public async collectInventory(
    machineId: string, 
    forceRefresh = false
  ): Promise<BaselineMachineInventory | null> {
    try {
      // Utiliser l'InventoryCollector existant
      const inventory = await this.inventoryCollector.collectInventory(machineId, forceRefresh);
      
      if (!inventory) {
        return null;
      }

      // Convertir vers le format BaselineMachineInventory
      return this.convertToBaselineFormat(inventory);
    } catch (error) {
      console.error('Erreur lors de la collecte de l\'inventaire:', error);
      return null;
    }
  }

  /**
   * Convertit l'inventaire existant vers le format BaselineMachineInventory
   */
  private convertToBaselineFormat(
    inventory: MachineInventory
  ): BaselineMachineInventory {
    return {
      machineId: inventory.machineId,
      timestamp: inventory.timestamp,
      config: {
        roo: {
          modes: [], // À extraire depuis les données réelles
          mcpSettings: {},
          userSettings: {}
        },
        hardware: {
          cpu: inventory.hardware.cpu.name,
          ram: `${Math.round(inventory.hardware.memory.total / 1024 / 1024 / 1024)}GB`,
          disks: inventory.hardware.disks.map(d => ({
            name: d.drive,
            size: `${Math.round(d.size / 1024 / 1024 / 1024)}GB`
          })),
          gpu: inventory.hardware.gpu?.map(g => g.name).join(', ')
        },
        software: {
          powershell: inventory.software.powershell,
          node: inventory.software.node || 'N/A',
          python: inventory.software.python || 'N/A'
        },
        system: {
          os: inventory.system.os,
          architecture: inventory.system.architecture
        }
      },
      metadata: {
        collectionDuration: 0, // À calculer
        source: 'local',
        collectorVersion: '1.0.0'
      }
    };
  }
}