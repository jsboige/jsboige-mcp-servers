import { getMachineInventoryTool } from '../../../tools/roosync/get-machine-inventory';

async function run() {
    console.log('Testing roosync_get_machine_inventory tool directly...');
    try {
        const result = await getMachineInventoryTool.execute({}, {} as any);
        console.log('Result:', JSON.stringify(result, null, 2));
    } catch (error) {
        console.error('Error:', error);
    }
}

run();