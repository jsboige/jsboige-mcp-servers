import type { Server } from 'http';
/**
 * Crée et démarre un serveur proxy.
 * @param targetUrl L'URL de destination vers laquelle les requêtes seront transférées.
 * @param port Le port sur lequel le serveur proxy écoutera.
 * @returns Une promesse qui se résout avec l'instance du serveur HTTP démarré.
 */
export declare function startProxy(targetUrl: string, port: number): Promise<Server>;
//# sourceMappingURL=proxy.d.ts.map