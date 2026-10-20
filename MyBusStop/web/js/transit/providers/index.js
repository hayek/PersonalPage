// Loads a provider on first use, so a rider in Oslo never downloads the Hong Kong adapters. Each
// comes wrapped so its unnumbered lines a rider cannot tell apart arrive as one service
// (js/transit/services.js).

import { withServices } from '../services.js';

const loaded = new Map();

/** @returns {Promise<import('../model.js').TransitProvider>} */
export function loadProvider(id) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(id)) return Promise.reject(new Error(`unknown provider ${id}`));
    if (!loaded.has(id)) {
        const promise = import(`./${id}.js`).then((module) => withServices(module.default));
        promise.catch(() => loaded.delete(id));
        loaded.set(id, promise);
    }
    return loaded.get(id);
}
