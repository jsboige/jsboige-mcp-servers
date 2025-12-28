const Trie = require('exact-trie');

const trie = new Trie();
const key = "**mission debug critique : réparation du système hiérarchique pour résoudre les 47 tâches orphelines**";
const entry = { id: 'test' };

console.log(`Key length: ${key.length}`);
console.log(`Key: "${key}"`);

trie.put(key, entry);

const retrieved = trie.getWithCheckpoints(key);
console.log('Retrieved:', retrieved);

if (retrieved === entry) {
    console.log('SUCCESS');
} else {
    console.log('FAILURE');
}

// Test with substring
const subKey = key.substring(0, key.length);
const retrievedSub = trie.getWithCheckpoints(subKey);
console.log('Retrieved Sub:', retrievedSub);