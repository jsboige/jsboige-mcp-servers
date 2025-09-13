export default async () => {
    if (global.__PROXY__) {
        console.log('--- Global Teardown: Closing Qdrant proxy...');
        global.__PROXY__.close();
    }
};
//# sourceMappingURL=global-teardown.js.map