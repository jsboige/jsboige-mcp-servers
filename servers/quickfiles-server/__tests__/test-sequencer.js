/**
 * Jest Test Sequencer - Ordre d'exécution des tests
 *
 * Exécute les tests anti-régression en premier pour une détection rapide des problèmes.
 */

import Sequencer from '@jest/test-sequencer';

export default class CustomSequencer extends Sequencer {
  sort(tests) {
    // Copie du tableau pour éviter de modifier l'original
    const copyTests = Array.from(tests);

    // Séparer les tests anti-régression des autres
    const antiRegressionTests = [];
    const otherTests = [];

    copyTests.forEach(test => {
      if (test.path.includes('anti-regression')) {
        antiRegressionTests.push(test);
      } else {
        otherTests.push(test);
      }
    });

    // Exécuter d'abord les tests anti-régression, puis les autres
    return [...antiRegressionTests, ...otherTests];
  }
}