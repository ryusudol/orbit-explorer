import type { Layers } from '../state/store';

/** Display groups in catalogue order (index = Group). */
export const GROUP_LABELS = ['Starlink', 'Debris & rocket bodies', 'Other payloads'];
export const GROUP_SHORT = ['Starlink', 'Debris', 'Payloads'];
/** The layer switch for each group, by group index. */
export const GROUP_LAYER: (keyof Layers)[] = ['starlink', 'debris', 'payload'];
/** Legend order: the constellation first, debris last. */
export const LEGEND_ORDER = [0, 2, 1];
