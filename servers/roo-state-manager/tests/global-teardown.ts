export default async () => {
  if ((global as any).__PROXY__) {
    console.log('--- Global Teardown: Closing Qdrant proxy...');
    (global as any).__PROXY__.close();
  }
};