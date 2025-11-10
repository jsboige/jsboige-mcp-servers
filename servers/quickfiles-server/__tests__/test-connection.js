// mcps/internal/servers/quickfiles-server/test-connection.js
import fetch from 'node-fetch';

async function testConnection() {
  const port = process.env.E2E_PORT || 3099;
  const url = `http://localhost:${port}/mcp`;

  // Tentative n°1 : Requête d'initialisation standard
  const initBody = {
    jsonrpc: '2.0',
    method: 'initialize',
    params: {
      capabilities: {
        // Aucune capacité spécifique requise pour ce test
      }
    },
    id: 1
  };

  try {
    console.log('[CLIENT] Attempting to initialize connection...');

    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'mcp-protocol-version': '2025-03-26', // Ajout du header version
        'Accept': 'application/json, text/event-stream' // Header crucial
      },
      body: JSON.stringify(initBody),
    };

    console.log('\n--- REQUEST DETAILS (Init) ---');
    console.log('URL:', url);
    console.log('Method:', fetchOptions.method);
    console.log('Headers:', JSON.stringify(fetchOptions.headers, null, 2));
    console.log('Body:', fetchOptions.body);
    console.log('----------------------------\n');

    const initResponse = await fetch(url, fetchOptions);

    const responseText = await initResponse.text();
    console.log(`[CLIENT] Raw response: ${responseText}`);
    
    // Le serveur retourne l'ID de session dans un en-tête
    const sessionId = initResponse.headers.get('mcp-session-id');

    if (!initResponse.ok || !sessionId) {
      console.error(`[CLIENT] Failed to initialize session. Status: ${initResponse.status}`);
      console.error(`[CLIENT] Body: ${responseText}`);
      throw new Error('Initialization failed.');
    }

    console.log(`[CLIENT] Session initialized successfully. Session ID: ${sessionId}`);

    // Tentative n°2 : Appeler un outil (list-tools) avec l'ID de session
    const listToolsBody = {
        jsonrpc: '2.0',
        method: 'list-tools',
        params: {},
        id: 2
    };

    console.log('\n[CLIENT] Attempting to call list-tools...');
    const listToolsResponse = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'mcp-protocol-version': '2025-03-26',
            'mcp-session-id': sessionId, // Utilisation de l'ID de session reçu
            'Accept': 'application/json, text/event-stream' // En-tête manquant
        },
        body: JSON.stringify(listToolsBody)
    });

    const listToolsText = await listToolsResponse.text();

    if (!listToolsResponse.ok) {
        console.error(`[CLIENT] Failed to call list-tools. Status: ${listToolsResponse.status}`);
        console.error(`[CLIENT] Body: ${listToolsText}`);
        throw new Error('list-tools call failed.');
    }

    console.log('[CLIENT] list-tools call successful!');
    console.log(`[CLIENT] Raw list-tools response: ${listToolsText}`);
    
    // Tentative n°3 : Terminer la session
    console.log('\n[CLIENT] Attempting to terminate session...');
    const deleteResponse = await fetch(url, {
        method: 'DELETE',
        headers: {
            'mcp-session-id': sessionId
        }
    });

    if (!deleteResponse.ok) {
        console.error(`[CLIENT] Failed to terminate session. Status: ${deleteResponse.status}`);
        throw new Error('DELETE call failed.');
    }
    
    console.log('[CLIENT] Session terminated successfully!');
    console.log('\n[SUCCESS] E2E test completed successfully!');
    
  } catch (error) {
    console.error('\n[FAILURE] E2E test failed:');
    console.error('Error message:', error.message);
    console.error('Error type:', error.type);
    console.error('Error cause:', error.cause);
    console.error('Full error object:', error);
    process.exit(1);
  }
}

testConnection();