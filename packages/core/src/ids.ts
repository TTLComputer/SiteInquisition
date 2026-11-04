import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

let lastTime = -1;
/** The 80 random bits as 16 base32 digits (5 bits each), most significant first. */
const rand: number[] = new Array(16).fill(0);

function freshRandom(): void {
  const bytes = randomBytes(16);
  for (let i = 0; i < 16; i++) rand[i] = bytes[i]! & 31;
}

/** Add one to the random part, carrying; within one millisecond this keeps ids strictly increasing. */
function increment(): void {
  for (let i = 15; i >= 0; i--) {
    if (rand[i]! < 31) {
      rand[i]!++;
      return;
    }
    rand[i] = 0;
  }
  throw new Error('ULID random part overflowed within one millisecond');
}

/**
 * Every row id is a ULID (https://github.com/ulid/spec): 48-bit millisecond
 * time plus 80 random bits in Crockford base32, sortable by creation time and
 * unique across machines, so two project databases can be merged later
 * without collisions. Ids made in the same millisecond (or if the clock steps
 * back) increase monotonically.
 */
export function newId(): string {
  const now = Date.now();
  if (now > lastTime) {
    lastTime = now;
    freshRandom();
  } else increment();
  let time = '';
  for (let t = lastTime, i = 0; i < 10; i++, t = Math.floor(t / 32)) time = ALPHABET[t % 32] + time;
  let out = time;
  for (const d of rand) out += ALPHABET[d];
  return out;
}
