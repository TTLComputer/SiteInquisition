import { monotonicFactory } from 'ulid';

/**
 * Every row id is a ULID: sortable by creation time and unique across
 * machines, so two project databases can be merged later without collisions.
 */
export const newId: () => string = monotonicFactory();
