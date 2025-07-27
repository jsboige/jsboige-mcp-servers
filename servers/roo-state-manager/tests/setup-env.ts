// Polyfill pour 'fetch' dans l'environnement de test Node.js / Jest
// Cela est nécessaire car la version native de fetch (ou undici) peut avoir des problèmes
// de connectivité dans certains contextes de test. 'node-fetch' est plus robuste.
import fetch, { Headers, Request, Response } from 'node-fetch';

if (!globalThis.fetch) {
  // @ts-ignore
  globalThis.fetch = fetch;
  // @ts-ignore
  globalThis.Headers = Headers;
  // @ts-ignore
  globalThis.Request = Request;
  // @ts-ignore
  globalThis.Response = Response;
}

import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.join(__dirname, '..', '.env') });