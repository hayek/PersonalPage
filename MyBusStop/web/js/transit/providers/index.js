// Loads a provider on first use, so a rider in Oslo never downloads the Hong Kong adapters.

const loaded = new Map();

/** @returns {Promise<import('../model.js').TransitProvider>} */
export function loadProvider(id) {
    if (!/^[a-z0-9-]+$/.test(id)) return Promise.reject(new Error(`unknown provider ${id}`));
    if (!loaded.has(id)) {
        const promise = import(`./${id}.js`).then((module) => module.default);
        promise.catch(() => loaded.delete(id));
        loaded.set(id, promise);
    }
    return loaded.get(id);
}
