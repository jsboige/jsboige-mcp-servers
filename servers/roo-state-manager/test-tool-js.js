// Script de test direct en JS pur pour valider l'outil buildé
const { getMachineInventoryTool } = require('./build/tools/roosync/get-machine-inventory.js');

async function run() {
    console.log('Testing roosync_get_machine_inventory tool (JS compiled) directly...');
    try {
        const result = await getMachineInventoryTool.execute({}, {});
        console.log('Success:', result.success);
        if (result.success) {
            console.log('Data Preview:', JSON.stringify(result.data, null, 2).substring(0, 500) + '...');
            console.log('Inventory Keys:', Object.keys(result.data.inventory));
        } else {
            console.error('Error:', result.error);
        }
    } catch (error) {
        console.error('Execution Error:', error);
    }
}

run();