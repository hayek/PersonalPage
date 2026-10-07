// A first guess at the rider's region from the browser's time zone, before any location is asked
// for. Only a guess: finding stops nearby, or picking from the list, settles it.

import { regionByID, WORLDWIDE } from '../transit/regions.js';

const BY_ZONE = {
    'Asia/Jerusalem': 'IL',
    'Asia/Tel_Aviv': 'IL',
    'Europe/Oslo': 'NO',
    'Europe/Helsinki': 'FI-TKU',
    'Europe/Lisbon': 'PT-LIS',
    'Europe/Paris': 'FR-RNS',
    'Europe/London': 'GB-LON',
    'Europe/Brussels': 'BE-BRU',
    'Europe/Zurich': 'CH',
    'Europe/Berlin': 'DE-NUE',
    'America/New_York': 'US-BOS',
    'America/Chicago': 'US-MSP',
    'America/Toronto': 'CA-TOR',
    'Asia/Hong_Kong': 'HK-KMB',
    'Asia/Tokyo': 'JP-TYO',
};

export function guessRegion() {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return regionByID(BY_ZONE[zone]) ?? WORLDWIDE;
    } catch {
        return WORLDWIDE;
    }
}
