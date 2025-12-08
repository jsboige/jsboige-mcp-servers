const dotenv = require('dotenv');
const path = require('path');

// Charger les variables d'environnement
dotenv.config({ path: path.join(__dirname, '../../.env') });

const QDRANT_URL = process.env.QDRANT_URL;

console.log('Testing connectivity to:', QDRANT_URL);

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

fetch(QDRANT_URL + '/collections')
    .then(res => {
        console.log('Status:', res.status);
        return res.json();
    })
    .then(data => {
        console.log('Data:', JSON.stringify(data, null, 2));
    })
    .catch(err => {
        console.error('Error:', err.message);
        console.error('Cause:', err.cause);
    });