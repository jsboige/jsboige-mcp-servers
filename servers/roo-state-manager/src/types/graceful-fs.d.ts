declare module 'graceful-fs' {
    import * as fs from 'fs';
    function gracefulify(fs: typeof import('fs')): void;
    const _default: typeof fs & { gracefulify: typeof gracefulify };
    export default _default;
    export { gracefulify };
}
